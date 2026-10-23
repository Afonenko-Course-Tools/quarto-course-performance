import { dirname, join, resolve } from "node:path";
import type { BuildOutcome } from "../report/types.ts";
import { recordCancellation } from "./resource-child.ts";

export interface OwnedProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  stdout?: WritableStream<Uint8Array>;
  stderr?: WritableStream<Uint8Array>;
  abortSignal?: AbortSignal;
  graceMilliseconds?: number;
  timeExecutable?: string | null;
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
async function liveGroup(group: number): Promise<boolean> {
  for await (const entry of Deno.readDir("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const stat = await Deno.readTextFile(`/proc/${entry.name}/stat`);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === group && fields[0] !== "Z") return true;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  return false;
}
export async function readOwnedGroup(path: string): Promise<number> {
  const value = JSON.parse(await Deno.readTextFile(path));
  if (!Number.isSafeInteger(value.group) || value.group <= 1) {
    throw new Error("Некорректный PGID в readiness receipt");
  }
  return value.group;
}

// Только аварийный путь до доверенного receipt: session создана нашим setsid PID.
// Дополнительные session признаются своими лишь по фактическому родству с ним.
async function ownedGroups(root: number, sessions: Set<number>): Promise<Set<number>> {
  const processes = new Map<
    number,
    { parent: number; group: number; session: number; live: boolean }
  >();
  for await (const entry of Deno.readDir("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const stat = await Deno.readTextFile(`/proc/${entry.name}/stat`);
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      processes.set(Number(entry.name), {
        parent: Number(f[1]),
        group: Number(f[2]),
        session: Number(f[3]),
        live: f[0] !== "Z",
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const descendants = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, process] of processes) {
      if (!descendants.has(pid) && descendants.has(process.parent)) {
        descendants.add(pid);
        sessions.add(process.session);
        changed = true;
      }
    }
  }
  const own = processes.get(Deno.pid)?.session;
  return new Set(
    [...processes.values()].filter((p) =>
      p.live && p.group > 1 &&
      p.session !== own && sessions.has(p.session)
    ).map((p) => p.group),
  );
}

async function tee(
  input: ReadableStream<Uint8Array>,
  path: string,
  output: WritableStream<Uint8Array>,
  failed: (error: unknown) => void,
) {
  let log: Deno.FsFile | undefined;
  let sink: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    log = await Deno.open(path, { write: true, create: true, truncate: true });
  } catch (error) {
    failed(error);
  }
  try {
    sink = output.getWriter();
  } catch (error) {
    failed(error);
  }
  try {
    for await (const chunk of input) {
      if (log) {
        try {
          let offset = 0;
          while (offset < chunk.length) offset += await log.write(chunk.subarray(offset));
        } catch (error) {
          failed(error);
          log.close();
          log = undefined;
        }
      }
      if (sink) {
        try {
          await sink.write(chunk);
        } catch (error) {
          failed(error);
          sink.releaseLock();
          sink = undefined;
        }
      }
    }
  } catch (error) {
    failed(error);
  } finally {
    sink?.releaseLock();
    log?.close();
  }
}

/** Одна собственная Linux group; сигналы не пересылаются повторно внутри дерева. */
export async function runOwnedProcess(options: OwnedProcessOptions): Promise<BuildOutcome> {
  if (Deno.build.os !== "linux") throw new Error("Нативный supervisor требует Linux setsid");
  const directory = dirname(resolve(options.stdoutPath));
  await Deno.mkdir(directory, { recursive: true });
  const receipt = join(directory, `status-${crypto.randomUUID()}.json`);
  const resources = receipt + ".resources";
  const cancelPath = receipt + ".cancel", spawnLock = receipt + ".spawn-lock";
  let time = options.timeExecutable === undefined ? "/usr/bin/time" : options.timeExecutable;
  if (time) {
    try {
      await Deno.stat(time);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      time = null;
    }
  }
  const helper = new URL("./resource-child.ts", import.meta.url).pathname;
  const deno = [Deno.execPath(), "run", "--no-config", "--no-lock", "-A", helper];
  const native = time
    ? [
      time,
      "-f",
      "%U %S %M",
      "-o",
      resources,
      "--",
      ...deno,
      receipt + ".native",
      options.executable,
      ...options.args,
    ]
    : [options.executable, ...options.args];
  const command = [...deno, "--owned", receipt, ...native];
  const stdoutTerminal = !options.stdout && Deno.stdout.isTerminal();
  const stderrTerminal = !options.stderr && Deno.stderr.isTerminal();
  const terminal = stdoutTerminal || stderrTerminal;
  const mixed = stdoutTerminal !== stderrTerminal;
  const redirectedInput = terminal && !Deno.stdin.isTerminal();
  const fifo = receipt + ".pipe";
  let redirected: Promise<Deno.FsFile> | undefined;
  let fifoKeeper: Deno.FsFile | undefined;
  if (mixed) {
    const prepared = await new Deno.Command("mkfifo", { args: [fifo] }).output();
    if (!prepared.success) {
      throw new Error("Не удалось подготовить канал терминального перенаправления");
    }
    // Deno 2.7 открывает FIFO до возврата Promise: временная read/write сторона
    // не даёт блокировать запуск писателя; закрывается после readiness.
    fifoKeeper = await Deno.open(fifo, { read: true, write: true });
    redirected = Deno.open(fifo, { read: true });
  }
  // script создаёт PTY только для терминальных fd; redirect идёт отдельным каналом.
  const terminalArgs = terminal
    ? [
      "script",
      "--quiet",
      "--return",
      "--flush",
      "--command",
      "exec env " +
      (options.env.SHELL === undefined ? "-u SHELL" : quote("SHELL=" + options.env.SHELL)) + " " +
      command.map(quote).join(" ") +
      (mixed ? ` ${stdoutTerminal ? 2 : 1}>${quote(fifo)}` : "") +
      (redirectedInput ? " 0<&3" : ""),
      "/dev/null",
    ]
    : command;
  // fd 3 дублирует исходный stdin до создания PTY, включая текущий file offset.
  const args = redirectedInput
    ? ["/bin/sh", "-c", "exec 3<&0; exec 0</dev/null; exec " + terminalArgs.map(quote).join(" ")]
    : terminalArgs;
  let group: number | undefined,
    pending: Deno.Signal | undefined,
    signalledAt = 0,
    escalated = false,
    failure: unknown;
  const sent = new Set<number>();
  const failed = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error("Ошибка supervisor", { cause: error });
  };
  const signalGroup = (target: number, signal: Deno.Signal) => {
    try {
      Deno.kill(-target, signal);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) failed(error);
    }
  };
  const spawning = () => {
    try {
      Deno.statSync(spawnLock);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      failed(error);
      return true;
    }
  };
  const send = (signal: Deno.Signal) => {
    pending ??= signal;
    try {
      recordCancellation(cancelPath, pending);
    } catch (error) {
      failed(error);
    }
    if (group) signalledAt ||= performance.now();
    // Spawn, начатый до cancel, завершится до группового TERM. Ещё не начатый
    // helper увидит cancel receipt и не породит child после этого сигнала.
    if (group && !sent.has(group) && !spawning()) {
      signalGroup(group, pending);
      sent.add(group);
    }
  };
  const term = () => send("SIGTERM"), interrupt = () => send("SIGINT");
  const abort = () => send(options.abortSignal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM");
  Deno.addSignalListener("SIGTERM", term);
  Deno.addSignalListener("SIGINT", interrupt);
  options.abortSignal?.addEventListener("abort", abort);
  if (options.abortSignal?.aborted) abort();
  const start = performance.now();
  try {
    const child = new Deno.Command("setsid", {
      args,
      cwd: options.cwd,
      env: {
        ...options.env,
        ...(terminal ? { SHELL: "/bin/sh" } : {}),
        COURSE_PERF_OWNED_GROUP: "1",
        COURSE_PERF_CANCEL_PATH: cancelPath,
        COURSE_PERF_SPAWN_LOCK: spawnLock,
      },
      clearEnv: true,
      stdin: "inherit",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const streams = terminal
      ? [
        tee(
          child.stdout,
          stdoutTerminal ? options.stdoutPath : options.stderrPath,
          stdoutTerminal ? Deno.stdout.writable : Deno.stderr.writable,
          failed,
        ),
        tee(
          child.stderr,
          mixed ? receipt + ".supervisor-stderr" : options.stderrPath,
          mixed ? new WritableStream({ write() {} }) : Deno.stderr.writable,
          failed,
        ),
        ...(redirected
          ? [(async () => {
            const file = await redirected;
            await tee(
              file!.readable,
              stdoutTerminal ? options.stderrPath : options.stdoutPath,
              stdoutTerminal
                ? (options.stderr ?? Deno.stderr.writable)
                : (options.stdout ?? Deno.stdout.writable),
              failed,
            );
          })()]
          : []),
      ]
      : [
        tee(child.stdout, options.stdoutPath, options.stdout ?? Deno.stdout.writable, failed),
        tee(child.stderr, options.stderrPath, options.stderr ?? Deno.stderr.writable, failed),
      ];
    const observed = streams.map((stream) => stream.catch(failed));
    const sessions = new Set([child.pid]);
    let status: Deno.CommandStatus | undefined;
    const completed = child.status.then((s) => {
      status = s;
    });
    while (true) {
      if (!group && !failure) {
        try {
          const candidate = await readOwnedGroup(receipt + ".ready");
          const owned = await ownedGroups(child.pid, sessions);
          // Регистрационный helper удерживает живую group до ack: любой
          // неподтверждённый candidate — ошибка, даже если такой PGID не существует.
          if (!owned.has(candidate)) {
            throw new Error("PGID readiness не принадлежит собственной session");
          }
          group = candidate;
          // sessions уже сохранены, пока ожидающий helper удерживает parent-chain.
          await Deno.writeTextFile(receipt + ".registered", "");
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) failed(error);
        }
      }
      if (group && pending) send(pending);
      if (group && !signalledAt) {
        try {
          const notice = JSON.parse(await Deno.readTextFile(receipt + ".signal"));
          if (!["SIGINT", "SIGTERM"].includes(notice.signal)) {
            throw new Error("Некорректный signal receipt");
          }
          // Этот сигнал PTY уже доставил; повторной пересылки нет.
          pending = notice.signal;
          sent.add(group);
          signalledAt = performance.now();
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) failed(error);
        }
      }
      if ((group || status || failure) && fifoKeeper) {
        fifoKeeper.close();
        fifoKeeper = undefined;
      }
      const remaining = failure
        ? await ownedGroups(child.pid, sessions)
        : new Set(group && await liveGroup(group) ? [group] : []);
      if (failure) {
        send(pending ?? "SIGTERM");
        // Proxy script завершается после native group; не сигналим ему TERM,
        // иначе script способен повторно переслать уже доставленный сигнал.
        const targets = remaining.size > 1
          ? [...remaining].filter((g) => g !== child.pid)
          : [...remaining];
        for (const target of targets) {
          if (!sent.has(target) && !spawning()) {
            signalGroup(target, "SIGTERM");
            sent.add(target);
          }
        }
        signalledAt ||= performance.now();
      }
      if (status && remaining.size === 0) break;
      if (signalledAt && performance.now() - signalledAt > (options.graceMilliseconds ?? 2000)) {
        for (const target of remaining) {
          if (!escalated) signalGroup(target, "SIGKILL");
        }
        if (remaining.size) escalated = true;
      }
      await pause(10);
    }
    await completed;
    await Promise.all(observed);
    if (failure) throw failure;
    if (mixed) await Deno.remove(fifo);
    let nativeStatus = status!;
    let nativeReceipt = false;
    for (const path of [receipt, ...(time ? [receipt + ".native"] : [])]) {
      try {
        nativeStatus = JSON.parse(await Deno.readTextFile(path));
        if (path.endsWith(".native") || !time) nativeReceipt = true;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
    if (escalated && !nativeReceipt) {
      nativeStatus = { code: 137, signal: "SIGKILL", success: false };
    }
    let cpuUserSeconds: number | null = null,
      cpuSystemSeconds: number | null = null,
      peakRssKiB: number | null = null;
    if (time) {
      try {
        const values = (await Deno.readTextFile(resources)).trim().split("\n").at(-1)!.split(" ")
          .map(Number);
        if (values.length === 3 && values.every(Number.isFinite)) {
          [cpuUserSeconds, cpuSystemSeconds, peakRssKiB] = values;
        }
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
    return {
      code: nativeStatus.code,
      signal: nativeStatus.signal,
      wallSeconds: (performance.now() - start) / 1000,
      cpuUserSeconds,
      cpuSystemSeconds,
      peakRssKiB,
      escalated,
      stdioMode: terminal && !mixed ? "pty-combined" : "separate",
    };
  } finally {
    fifoKeeper?.close();
    Deno.removeSignalListener("SIGTERM", term);
    Deno.removeSignalListener("SIGINT", interrupt);
    options.abortSignal?.removeEventListener("abort", abort);
  }
}
