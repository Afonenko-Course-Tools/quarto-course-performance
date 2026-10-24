import { join, relative, resolve } from "node:path";
import type {
  Mode,
  PreparationReceipt,
  PreparedVariant,
  RunResult,
  Scenario,
} from "../config/types.ts";
import { contained } from "../sources/snapshot.ts";
import { cleanEnvironment } from "./environment.ts";
export { cleanEnvironment } from "./environment.ts";
export interface ExecuteOptions {
  outputRoot?: string;
  env?: Record<string, string>;
  preparation?: PreparationReceipt[];
  diagnosticEnv?: Record<string, string>;
  cleanPaths?: string[];
  coverage?: { complete: boolean };
  useHyperfine?: boolean;
  runtimeRegistry?: string;
}
export async function executeScenario(
  scenario: Scenario,
  prepared: PreparedVariant,
  mode: Mode,
  options: ExecuteOptions = {},
): Promise<RunResult> {
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
      "run",
      "--no-config",
      "--no-lock",
      "-A",
      new URL("./resource-child.ts", import.meta.url).pathname,
      resolve(statusPath),
      scenario.executable,
      ...argv,
    ]
    : argv;
  const start = performance.now();
  const out = await new Deno.Command(executable, {
    args,
    cwd,
    env,
    clearEnv: true,
    stdin: "inherit",
    stdout: "piped",
    stderr: "piped",
  }).output();
  let wallSeconds = (performance.now() - start) / 1000,
    buildExitCode = out.code,
    signal = out.signal;
  await Deno.writeFile(join(outputDirectory, "stdout.log"), out.stdout);
  await Deno.writeFile(join(outputDirectory, "stderr.log"), out.stderr);
  let resources: {
    cpu_user_seconds: number | null;
    cpu_system_seconds: number | null;
    peak_rss_kib: number | null;
  } = { cpu_user_seconds: null, cpu_system_seconds: null, peak_rss_kib: null };
  if (options.useHyperfine) {
    const raw = JSON.parse(await Deno.readTextFile(join(outputDirectory, "hyperfine.json")));
    if (
      raw.schema_version !== 2 || raw.results.length !== 1 ||
      raw.results[0].measurements.length !== 1
    ) throw new Error("Неподдержанный формат Hyperfine");
    const measurement = raw.results[0].measurements[0];
    if (
      measurement.time_wall_clock?.unit !== "second" ||
      !Number.isFinite(measurement.time_wall_clock.value) ||
      !Number.isInteger(measurement.exit_code)
    ) throw new Error("Невалидное измерение Hyperfine");
    wallSeconds = measurement.time_wall_clock.value;
    buildExitCode = measurement.exit_code;
    resources = {
      cpu_user_seconds: measurement.time_user?.value ?? null,
      cpu_system_seconds: measurement.time_system?.value ?? null,
      peak_rss_kib: measurement.memory_peak_resident?.unit === "byte"
        ? measurement.memory_peak_resident.value / 1024
        : null,
    };
  } else if (useTime) {
    const status = JSON.parse(await Deno.readTextFile(statusPath));
    if (
      !Number.isInteger(status.code) || !Number.isFinite(status.toolWallSeconds) ||
      (status.signal !== null && typeof status.signal !== "string")
    ) {
      throw new Error("Невалидный native child status");
    }
    buildExitCode = status.code;
    signal = status.signal;
    wallSeconds = status.toolWallSeconds;
    const line = (await Deno.readTextFile(resourcesPath)).trim().split("\n").at(-1)!;
    const [user, system, rss] = line.split(" ").map(Number);
    if ([user, system, rss].every(Number.isFinite)) {
      resources = { cpu_user_seconds: user, cpu_system_seconds: system, peak_rss_kib: rss };
    }
  }
  let dataValid = mode === "off";
  if (mode !== "off") {
    const { normalizeRun } = await import("../analysis/normalize.ts");
    const normalized = await normalizeRun(outputDirectory);
    dataValid = normalized.dataValid;
  }
  const result: RunResult = {
    runId,
    buildExitCode,
    dataValid,
    outputDirectory,
    preparation: mode === "off" ? [] : options.preparation ?? [],
    wallSeconds,
    signal,
  };
  await Deno.writeTextFile(
    join(outputDirectory, "run.json"),
    JSON.stringify(
      {
        ...result,
        scenario: scenario.id,
        variant: prepared.variant,
        mode,
        argv: [scenario.executable, ...argv],
        cwd,
        cachePolicy: scenario.cachePolicy,
        courseProfile: scenario.courseProfile,
        experimentId: prepared.manifest.experimentId,
        resources,
        signalAvailability: options.useHyperfine ? "unavailable" : "observed",
        resourceScope: options.useHyperfine
          ? "native-hyperfine-command"
          : useTime
          ? "tool-and-resource-supervisor"
          : "unavailable",
      },
      null,
      2,
    ) + "\n",
  );
  return result;
}
