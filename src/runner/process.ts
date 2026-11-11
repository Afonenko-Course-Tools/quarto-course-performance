import { appDenoArgs, assetPath } from "../assets.ts";
import { dirname, join, resolve } from "node:path";
import type { BuildOutcome } from "../report/types.ts";
import { createProcessLifecycle } from "./process-lifecycle.ts";
import { prepareProcessOutput } from "./process-output.ts";
import { collectProcessOutcome } from "./process-sampling.ts";
export { readOwnedGroup } from "./process-tree.ts";

/** Ошибка измерения после остановки дерева; outcome — только для реально запущенного native. */
export class OwnedProcessError extends Error {
  constructor(error: unknown, readonly outcome?: BuildOutcome) {
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
  graceMilliseconds?: number;
  timeExecutable?: string | null;
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
  const output = await prepareProcessOutput(options, receipt, command);
  let failure: unknown;
  const failed = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error("Ошибка supervisor", { cause: error });
  };
  const lifecycle = createProcessLifecycle(options, receipt, failed, () => failure);
  const start = performance.now();
  let outcome: BuildOutcome | undefined, knownNativeOutcome: BuildOutcome | undefined;
  let processStarted = false, drained = false;
  try {
    const child = new Deno.Command("setsid", {
      args: output.args,
      cwd: options.cwd,
      env: {
        ...options.env,
        ...(output.terminal ? { SHELL: "/bin/sh" } : {}),
        COURSE_PERF_OWNED_GROUP: "1",
        COURSE_PERF_CANCEL_PATH: receipt + ".cancel",
        COURSE_PERF_SPAWN_LOCK: receipt + ".spawn-lock",
      },
      clearEnv: true,
      stdin: "inherit",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    processStarted = true;
    const streams = output.start(child, failed);
    const stopped = await lifecycle.wait(child, streams, output.releaseKeeper);
    drained = true;
    ({ outcome, knownNativeOutcome } = await collectProcessOutcome(
      {
        receipt,
        time,
        status: stopped.status,
        start,
        escalated: stopped.escalated,
        cancelled: stopped.cancelled,
        stdioMode: output.stdioMode,
      },
      failed,
    ));
  } finally {
    await output.dispose(!processStarted || drained, failed);
    lifecycle.dispose();
  }
  if (failure) throw new OwnedProcessError(failure, knownNativeOutcome);
  return outcome!;
}
