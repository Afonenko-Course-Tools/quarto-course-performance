import { appDenoArgs, assetPath } from "../assets.ts";
import { dirname, join, resolve } from "node:path";
import {
  type BuildOutcome,
  type CommandResult,
  type ProcessObservation,
  readNativeStatus,
  type StreamState,
} from "../report/types.ts";
import { recordCancellation } from "./resource-child.ts";

/** Ошибка измерения после остановки дерева; outcome — только для реально запущенного native. */
export class OwnedProcessError extends Error {
  constructor(error: unknown, readonly observation: ProcessObservation) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "OwnedProcessError";
  }
}

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
  onObservation?: (observation: ProcessObservation) => void;
  graceMilliseconds?: number;
  timeExecutable?: string | null;
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
function groupExists(group: number): boolean {
  try {
    Deno.kill(-group, 0);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
// /proc entry может исчезнуть между open и read: Linux возвращает ESRCH,
// которое Deno 2.7 представляет обычным Error, а не Deno.errors.NotFound.
function vanishedProcEntry(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound || error instanceof Error &&
      /^No such process \(os error 3\)(?:: readfile '\/proc\/\d+\/stat')?$/.test(error.message);
}
async function scanGroup(
  group: number,
  cleanupError?: (error: unknown) => void,
): Promise<{ live: boolean; zombies: number }> {
  let zombies = 0;
  for await (const entry of Deno.readDir("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const stat = await Deno.readTextFile(`/proc/${entry.name}/stat`);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) !== group) continue;
      if (fields[0] !== "Z") return { live: true, zombies };
      zombies++;
    } catch (error) {
      if (!vanishedProcEntry(error)) {
        if (!cleanupError) throw error;
        cleanupError(error);
      }
    }
  }
  return { live: false, zombies };
}
async function liveGroup(group: number, cleanupError?: (error: unknown) => void): Promise<boolean> {
  if (!groupExists(group)) return false;
  if ((await scanGroup(group, cleanupError)).live) return true;
  if (!groupExists(group)) return false;
  // Directory enumeration могла начаться до fork, а stat parent — после exit.
  // Новый снимок подтверждает zombie-only; пустота при существующей kernel group
  // остаётся неопределённостью, которую обычный цикл перепроверит без раннего return.
  const confirmed = await scanGroup(group, cleanupError);
  if (confirmed.live) return true;
  if (confirmed.zombies > 0) return false;
  return groupExists(group);
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
async function ownedGroups(
  root: number,
  sessions: Set<number>,
  cleanupError?: (error: unknown) => void,
): Promise<Set<number>> {
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
      if (!vanishedProcEntry(error)) {
        if (!cleanupError) throw error;
        cleanupError(error);
      }
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
  state: (state: StreamState) => void,
) {
  let log: Deno.FsFile | undefined;
  let sink: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let eof = false;
  const fail = (error: unknown) => {
    state("failed");
    failed(error);
  };
  // This pump owns its actual input channel now; opening the log can still fail.
  state("open");
  try {
    log = await Deno.open(path, { write: true, create: true, truncate: true });
  } catch (error) {
    fail(error);
  }
  try {
    sink = output.getWriter();
  } catch (error) {
    fail(error);
  }
  try {
    for await (const chunk of input) {
      if (log) {
        try {
          let offset = 0;
          while (offset < chunk.length) offset += await log.write(chunk.subarray(offset));
        } catch (error) {
          fail(error);
          try {
            log.close();
          } catch (closeError) {
            fail(closeError);
          }
          log = undefined;
        }
      }
      if (sink) {
        try {
          await sink.write(chunk);
        } catch (error) {
          fail(error);
          try {
            sink.releaseLock();
          } catch (closeError) {
            fail(closeError);
          }
          sink = undefined;
        }
      }
    }
    eof = true;
  } catch (error) {
    fail(error);
  } finally {
    try {
      sink?.releaseLock();
    } catch (error) {
      fail(error);
    }
    try {
      log?.close();
    } catch (error) {
      fail(error);
    }
    // A failed log stays failed even when its input was subsequently drained.
    if (eof) state("eof");
  }
}

/** Одна собственная Linux group; сигналы не пересылаются повторно внутри дерева. */
export async function runOwnedProcess(options: OwnedProcessOptions): Promise<ProcessObservation> {
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
  const helper = assetPath("src/runner/resource-child.ts");
  const deno = [Deno.execPath(), ...appDenoArgs(), helper];
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
  let nativeOutcome: BuildOutcome | null = null, commandResult: CommandResult | null = null;
  let streamsFinished = false;
  const streamFacts: ProcessObservation["streams"] = {
    stdout: "not-started",
    stderr: "not-started",
  };
  const observed = (): ProcessObservation => ({
    native: nativeOutcome,
    command: commandResult,
    streams: { ...streamFacts },
    stdioMode: streamFacts.stdout === "not-started" && streamFacts.stderr === "not-started"
      ? null
      : terminal && !mixed
      ? "pty-combined"
      : "separate",
    errors: failure ? [failure instanceof Error ? failure.message : String(failure)] : [],
    observedWallSeconds: (performance.now() - start) / 1000,
  });
  const failed = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error("Ошибка supervisor", { cause: error });
    options.onObservation?.(observed());
  };
  const streamState = (channel: "stdout" | "stderr" | null) => (state: StreamState) => {
    if (channel === null || streamFacts[channel] === "failed") return;
    streamFacts[channel] = state;
    options.onObservation?.(observed());
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
      // До проверки ownership ранняя отмена остаётся в очереди: helper должен
      // удерживать parent-chain. Scanner failure отменяет само ожидание регистрации.
      if (group || failure) recordCancellation(cancelPath, pending);
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
  const start = performance.now();
  const abort = () => send(options.abortSignal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM");
  options.abortSignal?.addEventListener("abort", abort);
  if (options.abortSignal?.aborted) abort();
  let processStarted = false, drained = false;
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
    processStarted = true;
    const streams = terminal
      ? [
        tee(
          child.stdout,
          stdoutTerminal ? options.stdoutPath : options.stderrPath,
          stdoutTerminal ? Deno.stdout.writable : Deno.stderr.writable,
          failed,
          streamState(stdoutTerminal ? "stdout" : "stderr"),
        ),
        tee(
          child.stderr,
          mixed ? receipt + ".supervisor-stderr" : options.stderrPath,
          mixed ? new WritableStream({ write() {} }) : Deno.stderr.writable,
          failed,
          // With two TTYs this is supervisor stderr, not independent native stderr.
          // With mixed redirection it has no public log channel at all.
          streamState(mixed ? null : "stderr"),
        ),
        ...(redirected
          ? [(async () => {
            const channel = stdoutTerminal ? "stderr" : "stdout";
            try {
              const file = await redirected;
              await tee(
                file!.readable,
                stdoutTerminal ? options.stderrPath : options.stdoutPath,
                stdoutTerminal
                  ? (options.stderr ?? Deno.stderr.writable)
                  : (options.stdout ?? Deno.stdout.writable),
                failed,
                streamState(channel),
              );
            } catch (error) {
              streamState(channel)("failed");
              failed(error);
            }
          })()]
          : []),
      ]
      : [
        tee(
          child.stdout,
          options.stdoutPath,
          options.stdout ?? Deno.stdout.writable,
          failed,
          streamState("stdout"),
        ),
        tee(
          child.stderr,
          options.stderrPath,
          options.stderr ?? Deno.stderr.writable,
          failed,
          streamState("stderr"),
        ),
      ];
    const observedStreams = streams.map((stream) => stream.catch(failed));
    const drainedStreams = Promise.all(observedStreams).then(() => {
      streamsFinished = true;
    });
    const sessions = new Set([child.pid]);
    let status: Deno.CommandStatus | undefined;
    const completed = child.status.then((s) => {
      status = s;
      commandResult = {
        code: s.code,
        signal: s.signal,
        wallSeconds: (performance.now() - start) / 1000,
      };
      options.onObservation?.(observed());
    }, failed);
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
          if (pending) send(pending);
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
      // До status состав подтверждённой group не влияет на normal completion.
      // Сигнал/ошибка сразу возвращают stop/escalation; после status scanner
      // по-прежнему ждёт живых потомков и отличает их от zombie-only group.
      if (group && !status && !failure && !pending && !signalledAt) {
        await pause(10);
        continue;
      }
      let remaining = new Set<number>(), scannerFailed = false;
      try {
        remaining = failure
          ? await ownedGroups(child.pid, sessions, failed)
          : new Set(group && await liveGroup(group) ? [group] : []);
        // Даже stale ancestry snapshot не отменяет уже подтверждённое владение group.
        if (failure && group && await liveGroup(group, failed)) remaining.add(group);
      } catch (error) {
        failed(error);
        scannerFailed = true;
        // Ошибка scanner не обходит stop/wait/drain. Только ранее подтверждённая
        // group известна без нового снимка; candidate из readiness здесь не доверяем.
        if (group) remaining.add(group);
      }
      // В аварийном снимке нечитаемый PID не даёт нового ownership. Подтверждённая
      // group всё равно получает stop/escalation, даже если её stat недоступен.
      if (failure && group && !escalated && groupExists(group)) remaining.add(group);
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
      // При отказе самой enumeration повторный /proc snapshot невозможен.
      // После KILL только подтверждённых групп ждём child и EOF обоих потоков;
      // zombie-only kernel PGID не заставляет supervisor зависнуть навсегда.
      if (scannerFailed && escalated && status && streamsFinished) break;
      if (signalledAt && performance.now() - signalledAt > (options.graceMilliseconds ?? 2000)) {
        for (const target of remaining) {
          if (!escalated) signalGroup(target, "SIGKILL");
        }
        if (remaining.size) escalated = true;
      }
      await pause(10);
    }
    await completed;
    await drainedStreams;
    drained = true;
    let nativeStatus:
      | { code: number; signal: Deno.Signal | null; toolWallSeconds?: number }
      | undefined;
    let nativeReceipt = false;
    for (const path of [receipt, ...(time ? [receipt + ".native"] : [])]) {
      try {
        nativeStatus = readNativeStatus(JSON.parse(await Deno.readTextFile(path)));
        if (path.endsWith(".native") || !time) nativeReceipt = true;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) failed(e);
      }
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
        if (!(e instanceof Deno.errors.NotFound)) failed(e);
      }
    }
    try {
      const started = await Deno.stat(receipt + (time ? ".native.started" : ".started"));
      if (started.isFile && nativeReceipt && nativeStatus) {
        if (
          !Number.isInteger(nativeStatus.code) || !Number.isFinite(nativeStatus.toolWallSeconds)
        ) {
          throw new Error("Неполный actual native receipt");
        }
        nativeOutcome = {
          code: nativeStatus.code,
          signal: nativeStatus.signal,
          wallSeconds: nativeStatus.toolWallSeconds!,
          cpuUserSeconds,
          cpuSystemSeconds,
          peakRssKiB,
          escalated,
          wallScope: "resource-helper-envelope",
          source: "native-receipt",
          resourceScope: time ? "tool-and-resource-helper" : "unavailable",
        };
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) failed(e);
    }
    if (!nativeOutcome) {
      failed(
        new Error("Actual native outcome отсутствует; wrapper/escalation не заменяют receipt"),
      );
    }
    options.onObservation?.(observed());
  } finally {
    try {
      fifoKeeper?.close();
    } catch (error) {
      failed(error);
    }
    // После await child/status/streams: служебный FIFO не является raw artifact.
    // Неудачный unlink не заменяет первую диагностическую ошибку.
    if (mixed && (!processStarted || drained)) {
      try {
        await Deno.remove(fifo);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) failed(error);
      }
    }
    options.abortSignal?.removeEventListener("abort", abort);
  }
  if (failure) throw new OwnedProcessError(failure, observed());
  return observed();
}
