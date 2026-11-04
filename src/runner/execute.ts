import { appDenoArgs, assetPath } from "../assets.ts";
import { join, relative, resolve } from "node:path";
import type { Mode, PreparedScript, PreparedVariant, Scenario } from "../config/types.ts";
import { contained } from "../sources/files.ts";
import { writeRunArtifacts } from "../report/run.ts";
import {
  type BuildOutcome,
  type CommandResult,
  PublicationError,
  type PublishedRun,
  readNativeStatus,
  type RunCompletion,
  type RunRecord,
  type StreamState,
} from "../report/types.ts";
import type { NormalizedRun } from "../analysis/normalize.ts";
import { cleanEnvironment } from "./environment.ts";
export { cleanEnvironment } from "./environment.ts";
/** Entrypoints own one cancellation lifetime for a run or the whole series. */
export async function withScenarioSignals<T>(use: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let received: "SIGTERM" | "SIGINT" | undefined;
  const remember = (signal: "SIGTERM" | "SIGINT") => {
    received ??= signal;
    if (!controller.signal.aborted) controller.abort(received);
  };
  const term = () => remember("SIGTERM"), interrupt = () => remember("SIGINT");
  Deno.addSignalListener("SIGTERM", term);
  Deno.addSignalListener("SIGINT", interrupt);
  try {
    return await use(controller.signal);
  } finally {
    Deno.removeSignalListener("SIGTERM", term);
    Deno.removeSignalListener("SIGINT", interrupt);
    if (received) {
      Deno.kill(Deno.pid, received);
      await new Promise<never>(() => {});
    }
  }
}
export interface ExecuteOptions {
  outputRoot?: string;
  env?: Record<string, string>;
  preparedScripts?: PreparedScript[];
  diagnosticEnv?: Record<string, string>;
  cleanPaths?: string[];
  coverage?: { complete: boolean };
  useHyperfine?: boolean;
  runtimeRegistry?: string;
  abortSignal?: AbortSignal;
}
function hyperfineOutcome(value: unknown): BuildOutcome {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Невалидное измерение Hyperfine");
    }
    return value as Record<string, unknown>;
  };
  const raw = object(value);
  if (raw.schema_version !== 2 || !Array.isArray(raw.results) || raw.results.length !== 1) {
    throw new Error("Неподдержанный формат Hyperfine");
  }
  const result = object(raw.results[0]);
  if (!Array.isArray(result.measurements) || result.measurements.length !== 1) {
    throw new Error("Неподдержанный формат Hyperfine");
  }
  const m = object(result.measurements[0]), wall = object(m.time_wall_clock);
  if (
    wall.unit !== "second" || typeof wall.value !== "number" || !Number.isFinite(wall.value) ||
    wall.value < 0 || typeof m.exit_code !== "number" || !Number.isSafeInteger(m.exit_code) ||
    m.exit_code < 0
  ) throw new Error("Невалидное измерение Hyperfine");
  const optional = (value: unknown): number | null => {
    if (value == null) return null;
    const metric = object(value);
    if (metric.value == null) return null;
    if (typeof metric.value !== "number" || !Number.isFinite(metric.value) || metric.value < 0) {
      throw new Error("Невалидное измерение Hyperfine");
    }
    return metric.value;
  };
  const memory = m.memory_peak_resident == null ? undefined : object(m.memory_peak_resident);
  const bytes = memory?.unit === "byte" ? optional(memory) : null;
  return {
    code: m.exit_code,
    signal: null,
    wallSeconds: wall.value,
    cpuUserSeconds: optional(m.time_user),
    cpuSystemSeconds: optional(m.time_system),
    peakRssKiB: bytes === null ? null : bytes / 1024,
    wallScope: "hyperfine-command",
    source: "hyperfine",
    resourceScope: "native-hyperfine-command",
  };
}
async function streamLog(
  input: ReadableStream<Uint8Array>,
  path: string,
  failed: (error: unknown) => void,
  state: (state: StreamState) => void,
  cancel: (stop: () => void) => void,
) {
  let log: Deno.FsFile | undefined;
  const close = () => {
    try {
      log?.close();
    } catch (error) {
      state("failed");
      failed(error);
    }
    log = undefined;
  };
  try {
    log = await Deno.open(path, { write: true, create: true, truncate: true });
  } catch (error) {
    state("failed");
    failed(error);
  }
  const reader = input.getReader();
  let stopped = false;
  cancel(() => {
    stopped = true;
    void reader.cancel().catch(failed);
  });
  try {
    while (!stopped) {
      const { done, value: chunk } = await reader.read();
      if (done) {
        if (!stopped) state("eof");
        break;
      }
      if (!log) continue;
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const written = await log.write(chunk.subarray(offset));
          if (written <= 0) throw new Error("Запись лога не продвинулась");
          offset += written;
        }
      } catch (error) {
        state("failed");
        failed(error);
        close();
      }
    }
  } catch (error) {
    state("failed");
    failed(error);
  } finally {
    reader.releaseLock();
    close();
  }
}
export async function executeScenario(
  scenario: Scenario,
  prepared: PreparedVariant,
  mode: Mode,
  options: ExecuteOptions = {},
): Promise<PublishedRun> {
  const root = await Deno.realPath(prepared.root), cwd = resolve(root, scenario.cwd);
  await contained(root, cwd);
  if (scenario.cachePolicy === "clean-output") {
    for (const path of options.cleanPaths ?? []) {
      const target = resolve(root, path), rel = relative(root, target);
      if (!rel || rel === ".." || rel.startsWith("../")) {
        throw new Error("Недопустимый output path");
      }
      try {
        await contained(root, target);
        await Deno.remove(target, { recursive: true });
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
  }
  const runId = crypto.randomUUID(),
    outputDirectory = join(options.outputRoot ?? "evidence/runs", runId);
  await Deno.mkdir(outputDirectory, { recursive: true });
  const argv = scenario.args.map((arg) =>
    arg.replaceAll("{course_root}", root)
      .replaceAll("{run_output}", resolve(outputDirectory))
      .replaceAll("{runtime_registry}", options.runtimeRegistry ?? "")
  );
  if (scenario.args.some((arg) => arg.includes("{runtime_registry}")) && !options.runtimeRegistry) {
    throw new Error("Сценарию необходим закреплённый runtime registry");
  }
  await Deno.writeTextFile(
    join(outputDirectory, "manifest.json"),
    JSON.stringify(prepared.manifest, null, 2) + "\n",
  );
  if (mode !== "off") {
    await Deno.writeTextFile(
      join(outputDirectory, "expectations.json"),
      JSON.stringify({ schema_version: 2, processes: [] }),
    );
    await Deno.writeTextFile(
      join(outputDirectory, "mode.json"),
      JSON.stringify({ mode, runId, experimentId: prepared.manifest.experimentId }),
    );
    if (options.coverage) {
      await Deno.writeTextFile(
        join(outputDirectory, "coverage.json"),
        JSON.stringify(options.coverage, null, 2) + "\n",
      );
    }
  }
  const env = cleanEnvironment({ ...Deno.env.toObject(), ...options.env });
  if (mode !== "off") {
    Object.assign(env, options.diagnosticEnv, {
      COURSE_PERF_MODE: mode,
      COURSE_PERF_EXPERIMENT_ID: prepared.manifest.experimentId,
      COURSE_PERF_RUN_ID: runId,
      COURSE_PERF_OUTPUT_DIR: resolve(outputDirectory),
    });
  }
  const resourcesPath = join(outputDirectory, "resources.txt");
  const statusPath = join(outputDirectory, "tool-status.json");
  let useTime = false;
  try {
    useTime = (await Deno.stat("/usr/bin/time")).isFile &&
      (scenario.resources.cpu || scenario.resources.peakRss);
  } catch { /* Недоступные ресурсы остаются null. */ }
  const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
  const executable = options.useHyperfine
    ? "hyperfine"
    : useTime
    ? "/usr/bin/time"
    : scenario.executable;
  const args = options.useHyperfine
    ? [
      "--runs",
      "1",
      "--warmup",
      "0",
      "--shell",
      "none",
      "--ignore-failure",
      "--show-output",
      "--metrics",
      "time_wall_clock,time_cpu,time_user,time_system,memory_peak_resident",
      "--export-json",
      resolve(join(outputDirectory, "hyperfine.json")),
      [scenario.executable, ...argv].map(quote).join(" "),
    ]
    : useTime
    ? [
      "-f",
      "%U %S %M",
      "-o",
      resolve(resourcesPath),
      "--",
      Deno.execPath(),
      ...appDenoArgs(),
      assetPath("src/runner/resource-child.ts"),
      resolve(statusPath),
      scenario.executable,
      ...argv,
    ]
    : argv;
  const started = performance.now();
  let child: Deno.ChildProcess | undefined;
  let native: BuildOutcome | null = null, command: CommandResult | null = null;
  const streams: { stdout: StreamState; stderr: StreamState } = {
    stdout: "not-started",
    stderr: "not-started",
  };
  const errors: string[] = [], stops: (() => void)[] = [];
  let selected: RunRecord | undefined, normalized: NormalizedRun | undefined;
  let notify: (record: RunRecord) => void = () => {};
  const terminal = new Promise<RunRecord>((resolve) => {
    notify = resolve;
  });
  const snapshot = (completion: RunCompletion): RunRecord => ({
    schema_version: 2,
    runId,
    request: {
      cwd,
      quarto: scenario.executable,
      nativeArgv: argv[0] === "render" ? argv.slice(1) : [...argv],
      mode,
    },
    completion,
    command,
    streams: { ...streams },
    stdioMode: streams.stdout === "not-started" && streams.stderr === "not-started"
      ? null
      : "separate",
    observedWallSeconds: (performance.now() - started) / 1000,
    preparedScripts: mode === "off" ? [] : [...options.preparedScripts ?? []],
    dataValid: completion.kind === "complete" && (normalized?.dataValid ?? mode === "off"),
    quality: {
      droppedEvents: normalized?.quality.droppedEvents ?? 0,
      incompleteSpans: normalized?.quality.incompleteSpans ?? 0,
      coverageComplete: completion.kind === "complete" &&
        (normalized?.quality.coverageComplete ?? false),
      errors: [...normalized?.quality.errors ?? [], ...errors],
    },
    versions: {
      tool: "2.0.0",
      quarto: prepared.manifest.runtime.quarto?.version ?? "неизвестно",
      deno: prepared.manifest.runtime.deno?.version ?? null,
      pandoc: prepared.manifest.runtime.pandoc?.version ?? null,
    },
    git: null,
    collectionDirectory: resolve(outputDirectory),
    artifacts: { manifest: "manifest.json" },
    scenario: scenario.id,
    variant: prepared.variant,
    mode,
    argv: [scenario.executable, ...argv],
    cwd,
    cachePolicy: scenario.cachePolicy,
    experimentId: prepared.manifest.experimentId,
  });
  // The only terminal choice. No async work or competing writers here.
  const choose = (completion: RunCompletion) => {
    if (selected) return;
    selected = snapshot(completion);
    notify(selected);
  };
  let forwarded = false;
  const failed = (cause: unknown) => {
    if (selected) return;
    errors.push(cause instanceof Error ? cause.message : String(cause));
    if (child && !forwarded) {
      forwarded = true;
      try {
        child.kill("SIGTERM");
      } catch { /* Teardown does not invent a status. */ }
    }
    choose({ kind: "incomplete", reason: "observation-error", requestedSignal: null, native });
  };
  const abort = () => {
    if (selected) return;
    const signal = options.abortSignal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
    if (child && !forwarded) {
      forwarded = true;
      try {
        child.kill(signal);
      } catch { /* Actual status remains independent. */ }
    }
    choose({ kind: "incomplete", reason: "interrupted", requestedSignal: signal, native });
  };
  options.abortSignal?.addEventListener("abort", abort);
  if (options.abortSignal?.aborted) abort();
  let previous: PublishedRun | undefined;
  try {
    // Initial and terminal writes are serialized, including cancellation during rename.
    try {
      previous = await writeRunArtifacts(
        outputDirectory,
        snapshot({
          kind: "incomplete",
          reason: "not-finalized",
          requestedSignal: null,
          native: null,
        }),
      );
    } catch (cause) {
      if (cause instanceof PublicationError) previous = cause.published;
      if (!selected) throw cause; // Never spawn after checkpoint failure.
    }
    if (!selected) {
      const commandStarted = performance.now();
      try {
        // No await between cancellation check and spawn.
        child = new Deno.Command(executable, {
          args,
          cwd,
          env,
          clearEnv: true,
          stdin: "inherit",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        streams.stdout = streams.stderr = "open";
        const register = (stop: () => void) => {
          stops.push(stop);
          if (selected) stop();
        };
        const stdout = streamLog(
          child.stdout,
          join(outputDirectory, "stdout.log"),
          failed,
          (state) => {
            streams.stdout = state;
          },
          register,
        );
        const stderr = streamLog(
          child.stderr,
          join(outputDirectory, "stderr.log"),
          failed,
          (state) => {
            streams.stderr = state;
          },
          register,
        );
        const status = child.status.then((out) => {
          // Status wall excludes later EOF, resource reads, normalize and report.
          command = {
            code: out.code,
            signal: out.signal,
            wallSeconds: (performance.now() - commandStarted) / 1000,
          };
          if (!options.useHyperfine && !useTime) {
            native = {
              ...command,
              cpuUserSeconds: null,
              cpuSystemSeconds: null,
              peakRssKiB: null,
              wallScope: "direct-spawn-to-status",
              source: "direct-status",
              resourceScope: "unavailable",
            };
          }
        }, failed);
        void (async () => {
          await Promise.all([status, stdout, stderr]);
          if (selected) return;
          if (!command || streams.stdout !== "eof" || streams.stderr !== "eof") {
            throw new Error("Неполное наблюдение команды");
          }
          if (options.useHyperfine) {
            native = hyperfineOutcome(
              JSON.parse(await Deno.readTextFile(join(outputDirectory, "hyperfine.json"))),
            );
          } else if (useTime) {
            const result = readNativeStatus(JSON.parse(await Deno.readTextFile(statusPath)));
            native = {
              code: result.code,
              signal: result.signal,
              wallSeconds: result.toolWallSeconds,
              cpuUserSeconds: null,
              cpuSystemSeconds: null,
              peakRssKiB: null,
              wallScope: "resource-helper-envelope",
              source: "native-receipt",
              resourceScope: "tool-and-resource-helper",
            };
            const [user, system, rss] = (await Deno.readTextFile(resourcesPath)).trim().split("\n")
              .at(-1)!.split(" ").map(Number);
            if (![user, system, rss].every(Number.isFinite)) {
              throw new Error("Невалидные resource measurements");
            }
            native = { ...native, cpuUserSeconds: user, cpuSystemSeconds: system, peakRssKiB: rss };
          }
          if (selected) return;
          if (!native) throw new Error("Native outcome неизвестен");
          if (mode !== "off") {
            const { normalizeRun } = await import("../analysis/normalize.ts");
            if (selected) return;
            normalized = await normalizeRun(outputDirectory);
            if (!normalized.dataValid) throw new Error("Невалидное наблюдение диагностики");
          }
          if (!selected) choose({ kind: "complete", native });
        })().catch(failed);
      } catch (cause) {
        failed(cause);
      }
    }
    const record = await terminal;
    // Publication never waits for pipe holders or child teardown on partial paths.
    if (record.completion.kind === "incomplete") { for (const stop of stops) stop(); }
    return await writeRunArtifacts(
      outputDirectory,
      record,
      record.completion.kind === "complete" ? normalized : undefined,
      previous,
    );
  } finally {
    options.abortSignal?.removeEventListener("abort", abort);
  }
}
