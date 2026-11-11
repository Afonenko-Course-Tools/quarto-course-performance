import { toolVersion } from "../assets.ts";
import { join, relative, resolve } from "node:path";
import type { NormalizedRun } from "../analysis/normalize.ts";
import type {
  Mode,
  PreparedScript,
  PreparedVariant,
  RunResult,
  Scenario,
} from "../config/types.ts";
import { writeRunArtifacts } from "../report/run.ts";
import { type ExperimentRunRecord } from "../report/types.ts";
import { contained } from "../sources/files.ts";
import { cleanEnvironment } from "./environment.ts";
import { measureScenario } from "./execute-measurement.ts";
export { cleanEnvironment } from "./environment.ts";
export interface ExecuteOptions {
  outputRoot?: string;
  abortSignal?: AbortSignal;
  env?: Record<string, string>;
  preparedScripts?: PreparedScript[];
  diagnosticEnv?: Record<string, string>;
  cleanPaths?: string[];
  coverage?: { complete: boolean };
  useHyperfine?: boolean;
  runtimeRegistry?: string;
}
async function cleanScenarioOutputs(
  root: string,
  scenario: Scenario,
  options: ExecuteOptions,
): Promise<void> {
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
}
export async function executeScenario(
  scenario: Scenario,
  prepared: PreparedVariant,
  mode: Mode,
  options: ExecuteOptions = {},
): Promise<RunResult> {
  const root = await Deno.realPath(prepared.root), cwd = resolve(root, scenario.cwd);
  await contained(root, cwd);
  await cleanScenarioOutputs(root, scenario, options);
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
  const measurement = await measureScenario({
    executable: scenario.executable,
    argv,
    cwd,
    env,
    outputDirectory,
    useHyperfine: options.useHyperfine ?? false,
    resources: scenario.resources.cpu || scenario.resources.peakRss,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
  const { code: buildExitCode, wallSeconds, signal } = measurement.outcome;
  const resources = {
    cpu_user_seconds: measurement.outcome.cpuUserSeconds,
    cpu_system_seconds: measurement.outcome.cpuSystemSeconds,
    peak_rss_kib: measurement.outcome.peakRssKiB,
  };
  let dataValid = mode === "off";
  let normalized: NormalizedRun | undefined;
  if (mode !== "off") {
    const { normalizeRun } = await import("../analysis/normalize.ts");
    normalized = await normalizeRun(outputDirectory);
    dataValid = normalized.dataValid;
  }
  if (measurement.error) {
    dataValid = false;
    normalized ??= {
      runId,
      events: [],
      executors: {},
      dataValid: false,
      quality: { droppedEvents: 0, incompleteSpans: 0, coverageComplete: false, errors: [] },
    };
    normalized.dataValid = false;
    normalized.quality.coverageComplete = false;
    normalized.quality.errors.push(String(measurement.error));
  }
  const result: RunResult = {
    runId,
    buildExitCode,
    dataValid,
    outputDirectory,
    preparedScripts: mode === "off" ? [] : options.preparedScripts ?? [],
    wallSeconds,
    signal,
  };
  const record: ExperimentRunRecord = {
    schema_version: 2,
    ...result,
    request: {
      cwd,
      quarto: scenario.executable,
      nativeArgv: argv[0] === "render" ? argv.slice(1) : argv,
      mode,
    },
    outcome: {
      code: buildExitCode,
      signal,
      wallSeconds,
      cpuUserSeconds: resources.cpu_user_seconds,
      cpuSystemSeconds: resources.cpu_system_seconds,
      peakRssKiB: resources.peak_rss_kib,
    },
    quality: normalized?.quality ??
      { droppedEvents: 0, incompleteSpans: 0, coverageComplete: false, errors: [] },
    versions: {
      tool: await toolVersion(),
      quarto: prepared.manifest.runtime.quarto?.version ?? "неизвестно",
      deno: prepared.manifest.runtime.deno?.version ?? null,
      pandoc: prepared.manifest.runtime.pandoc?.version ?? null,
    },
    git: null,
    collectionDirectory: resolve(outputDirectory),
    outputDirectory: resolve(outputDirectory),
    artifacts: {},
    ...{
      scenario: scenario.id,
      variant: prepared.variant,
      mode,
      argv: [scenario.executable, ...argv],
      cwd,
      cachePolicy: scenario.cachePolicy,
      experimentId: prepared.manifest.experimentId,
      resources,
      signalAvailability: options.useHyperfine ? "unavailable" : "observed",
      resourceScope: measurement.resourceScope,
    },
  };
  await writeRunArtifacts(outputDirectory, record, normalized);
  return result;
}

/** CLI владеет внешним сигналом до сохранения отчёта и завершения своего native дерева. */
export async function withScenarioSignals<T>(
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let requested: Deno.Signal | null = null;
  const remember = (signal: Deno.Signal) => {
    requested ??= signal;
    controller.abort(requested);
  };
  const interrupt = () => remember("SIGINT"), terminate = () => remember("SIGTERM");
  Deno.addSignalListener("SIGINT", interrupt);
  Deno.addSignalListener("SIGTERM", terminate);
  try {
    return await action(controller.signal);
  } finally {
    Deno.removeSignalListener("SIGINT", interrupt);
    Deno.removeSignalListener("SIGTERM", terminate);
    if (requested) {
      Deno.kill(Deno.pid, requested);
      await new Promise(() => {});
    }
  }
}
