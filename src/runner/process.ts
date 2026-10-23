import { dirname, join, resolve } from "node:path";
import type { BuildOutcome } from "../report/types.ts";

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
async function tee(
  input: ReadableStream<Uint8Array>,
  path: string,
  output: WritableStream<Uint8Array>,
) {
  const log = await Deno.open(path, { write: true, create: true, truncate: true });
  const sink = output.getWriter();
  try {
    for await (const chunk of input) {
      let offset = 0;
      while (offset < chunk.length) offset += await log.write(chunk.subarray(offset));
      await sink.write(chunk);
    }
  } finally {
    sink.releaseLock();
    log.close();
  }
}

/** Одна собственная Linux group; сигналы не пересылаются повторно внутри дерева. */
export async function runOwnedProcess(options: OwnedProcessOptions): Promise<BuildOutcome> {
  if (Deno.build.os !== "linux") throw new Error("Нативный supervisor требует Linux setsid");
  const directory = dirname(resolve(options.stdoutPath));
  await Deno.mkdir(directory, { recursive: true });
  const receipt = join(directory, `status-${crypto.randomUUID()}.json`);
  const resources = receipt + ".resources";
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
    escalated = false;
  const send = (signal: Deno.Signal) => {
    pending = signal;
    if (group && !signalledAt) {
      try {
        Deno.kill(-group, signal);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
      signalledAt = performance.now();
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
        ),
        tee(
          child.stderr,
          mixed ? receipt + ".supervisor-stderr" : options.stderrPath,
          mixed ? new WritableStream({ write() {} }) : Deno.stderr.writable,
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
            );
          })()]
          : []),
      ]
      : [
        tee(child.stdout, options.stdoutPath, options.stdout ?? Deno.stdout.writable),
        tee(child.stderr, options.stderrPath, options.stderr ?? Deno.stderr.writable),
      ];
    let status: Deno.CommandStatus | undefined;
    const completed = child.status.then((s) => {
      status = s;
    });
    while (true) {
      if (!group) {
        try {
          group = JSON.parse(await Deno.readTextFile(receipt + ".ready")).group;
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
        if (group && pending) send(pending);
      }
      if ((group || status) && fifoKeeper) {
        fifoKeeper.close();
        fifoKeeper = undefined;
      }
      if (status && (group === undefined || !await liveGroup(group))) break;
      if (
        group && signalledAt && !escalated &&
        performance.now() - signalledAt > (options.graceMilliseconds ?? 2000)
      ) {
        escalated = true;
        try {
          Deno.kill(-group, "SIGKILL");
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      }
      await pause(10);
    }
    await completed;
    await Promise.all(streams);
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
