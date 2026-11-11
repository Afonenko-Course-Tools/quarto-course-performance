import type { OwnedProcessOptions } from "./process.ts";

const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";

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

/** Каналы вывода и PTY имеют общий срок жизни; сигналами владеет только lifecycle. */
export async function prepareProcessOutput(
  options: OwnedProcessOptions,
  receipt: string,
  command: string[],
) {
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
  return {
    args,
    terminal,
    stdioMode: terminal && !mixed ? "pty-combined" as const : "separate" as const,
    releaseKeeper() {
      fifoKeeper?.close();
      fifoKeeper = undefined;
    },
    start(child: Deno.ChildProcess, failed: (error: unknown) => void) {
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
      let streamsFinished = false;
      const drainedStreams = Promise.all(observed).then(() => {
        streamsFinished = true;
      });
      return { drained: drainedStreams, finished: () => streamsFinished };
    },
    async dispose(canRemove: boolean, failed: (error: unknown) => void) {
      try {
        fifoKeeper?.close();
      } catch (error) {
        failed(error);
      }
      // Канал удаляется только после EOF либо до появления дочернего процесса.
      if (mixed && canRemove) {
        try {
          const file = await redirected;
          try {
            file?.close();
          } catch (error) {
            if (!(error instanceof Deno.errors.BadResource)) failed(error);
          }
          await Deno.remove(fifo);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) failed(error);
        }
      }
    },
  };
}
