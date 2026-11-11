import { join, resolve } from "node:path";
import { array, number, object, parseObject } from "../json.ts";
import type { BuildOutcome } from "../report/types.ts";
import { OwnedProcessError, runOwnedProcess } from "./process.ts";
export interface ScenarioMeasurement {
  outcome: BuildOutcome;
  error?: unknown;
  resourceScope: "native-hyperfine-command" | "tool-and-resource-supervisor" | "unavailable";
}
interface MeasureRequest {
  executable: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  outputDirectory: string;
  useHyperfine: boolean;
  resources: boolean;
  abortSignal?: AbortSignal;
}
async function hyperfineOutcome(
  outputDirectory: string,
  outcome: BuildOutcome,
): Promise<BuildOutcome> {
  const raw = parseObject(await Deno.readTextFile(join(outputDirectory, "hyperfine.json")));
  if (
    raw.schema_version !== 2 || array(raw.results).length !== 1 ||
    array(object(array(raw.results)[0]).measurements).length !== 1
  ) throw new Error("Неподдержанный формат Hyperfine");
  const measurement = object(array(object(array(raw.results)[0]).measurements)[0]);
  const wall = object(measurement.time_wall_clock);
  if (
    wall.unit !== "second" ||
    !Number.isFinite(wall.value) ||
    !Number.isInteger(measurement.exit_code)
  ) throw new Error("Невалидное измерение Hyperfine");
  const wallSeconds = number(wall.value);
  const buildExitCode = number(measurement.exit_code);
  const resources = {
    cpu_user_seconds: measurement.time_user === undefined
      ? null
      : number(object(measurement.time_user).value),
    cpu_system_seconds: measurement.time_system === undefined
      ? null
      : number(object(measurement.time_system).value),
    peak_rss_kib: measurement.memory_peak_resident !== undefined &&
        object(measurement.memory_peak_resident).unit === "byte"
      ? number(object(measurement.memory_peak_resident).value) / 1024
      : null,
  };
  return {
    ...outcome,
    code: buildExitCode,
    wallSeconds,
    signal: null,
    cpuUserSeconds: resources.cpu_user_seconds,
    cpuSystemSeconds: resources.cpu_system_seconds,
    peakRssKiB: resources.peak_rss_kib,
  };
}
export async function measureScenario(request: MeasureRequest): Promise<ScenarioMeasurement> {
  const { executable, argv, cwd, env, outputDirectory, useHyperfine } = request;
  const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
  const args = useHyperfine
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
      [executable, ...argv].map(quote).join(" "),
    ]
    : argv;
  let outcome: BuildOutcome, error: unknown;
  try {
    outcome = await runOwnedProcess({
      executable: useHyperfine ? "hyperfine" : executable,
      args,
      cwd,
      env,
      stdoutPath: join(outputDirectory, "stdout.log"),
      stderrPath: join(outputDirectory, "stderr.log"),
      timeExecutable: !useHyperfine && request.resources ? "/usr/bin/time" : null,
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    });
  } catch (failure) {
    if (!(failure instanceof OwnedProcessError) || !failure.outcome) throw failure;
    outcome = failure.outcome;
    error = failure;
  }
  if (useHyperfine) {
    if (outcome.code !== 0 || outcome.signal || error) {
      throw new Error(
        `Hyperfine не завершил измерение: code=${outcome.code}, signal=${
          outcome.signal ?? "none"
        }; материалы сохранены: ${outputDirectory}`,
        { cause: error },
      );
    }
    outcome = await hyperfineOutcome(outputDirectory, outcome);
  }
  return {
    outcome,
    ...(error === undefined ? {} : { error }),
    resourceScope: useHyperfine
      ? "native-hyperfine-command"
      : request.resources
      ? "tool-and-resource-supervisor"
      : "unavailable",
  };
}
