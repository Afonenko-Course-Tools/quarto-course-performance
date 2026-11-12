import { isAbsolute } from "node:path";
import { array, boolean, number, object, oneOf, string, strings } from "../json.ts";
import { type OutputPolicy, type Scenario } from "./types.ts";
export interface PerformanceConfig {
  schema_version: 2;
  projectSource: string;
  benchmark?: { pairs?: number; maxSlowdownRatio: number };
  outputPolicy?: OutputPolicy;
  scenarios: Scenario[];
  cleanPaths?: string[];
  runtime?: { quarto?: string };
}
function parseConfig(value: unknown): PerformanceConfig {
  if (!value || typeof value !== "object") throw new Error("Конфигурация должна быть объектом");
  const c = object(value, "config");
  if (c.schema_version !== 2) throw new Error("Необходима конфигурация v2");
  if ("sources" in c || "replacements" in c) {
    throw new Error(
      "Подготовьте локальные checkout через Git и quarto add; sources/replacements удалены",
    );
  }
  const scenarios: Scenario[] = array(c.scenarios, "scenarios").map((value) => {
    const scenario = object(value, "scenario");
    const scope = object(scenario.scope, "scope"),
      resources = object(scenario.resources, "resources");
    if ("project" in scenario || "courseProfile" in scenario) {
      throw new Error("Недопустимый scenario");
    }
    return {
      ...scenario,
      id: string(scenario.id),
      cwd: string(scenario.cwd),
      executable: oneOf(scenario.executable, ["quarto"]),
      args: strings(scenario.args),
      mode: oneOf(scenario.mode, ["off", "summary", "cpu", "trace"]),
      cachePolicy: oneOf(scenario.cachePolicy, ["clean-output", "repeat-render"]),
      scope: {
        ...scope,
        modules: strings(scope.modules),
        extensions: strings(scope.extensions),
        strict: boolean(scope.strict),
      },
      resources: {
        ...resources,
        wall: boolean(resources.wall),
        cpu: boolean(resources.cpu),
        peakRss: boolean(resources.peakRss),
      },
    };
  });
  const { benchmark: benchmarkValue, cleanPaths, runtime, outputPolicy, ...fields } = c;
  let checkedBenchmark: PerformanceConfig["benchmark"];
  if (benchmarkValue !== undefined) {
    const { pairs, ...benchmarkFields } = object(benchmarkValue, "benchmark");
    checkedBenchmark = {
      ...benchmarkFields,
      maxSlowdownRatio: number(benchmarkFields.maxSlowdownRatio),
      ...(pairs === undefined ? {} : { pairs: number(pairs) }),
    };
  }
  let checkedRuntime: PerformanceConfig["runtime"];
  if (runtime !== undefined) {
    const { quarto, ...runtimeFields } = object(runtime, "runtime");
    checkedRuntime = {
      ...runtimeFields,
      ...(quarto === undefined ? {} : { quarto: string(quarto) }),
    };
  }
  const checked: PerformanceConfig = {
    ...fields,
    schema_version: 2,
    projectSource: string(c.projectSource),
    scenarios,
    ...(outputPolicy === undefined
      ? {}
      : { outputPolicy: oneOf(outputPolicy, ["strict", "java-pilot-core-qrc-v1"]) }),
    ...(checkedBenchmark === undefined ? {} : { benchmark: checkedBenchmark }),
    ...(cleanPaths === undefined ? {} : { cleanPaths: strings(cleanPaths) }),
    ...(checkedRuntime === undefined ? {} : { runtime: checkedRuntime }),
  };
  return checked;
}
function validateScenarios(checked: PerformanceConfig) {
  const ids = new Set<string>();
  for (const s of checked.scenarios) {
    if (!/^[\w-]+$/.test(s.id) || ids.has(s.id)) {
      throw new Error("Повтор или некорректный scenario id");
    }
    ids.add(s.id);
    if (
      typeof s.cwd !== "string" || isAbsolute(s.cwd) || s.cwd.split(/[\\/]/).includes("..") ||
      s.executable !== "quarto" ||
      !Array.isArray(s.args) || s.args.some((x) => typeof x !== "string") ||
      !["off", "summary", "cpu", "trace"].includes(s.mode) ||
      !["clean-output", "repeat-render"].includes(s.cachePolicy) ||
      "project" in s || "courseProfile" in s ||
      !Array.isArray(s.scope?.modules) || !Array.isArray(s.scope?.extensions) ||
      typeof s.scope.strict !== "boolean" || typeof s.resources?.wall !== "boolean" ||
      typeof s.resources.cpu !== "boolean" || typeof s.resources.peakRss !== "boolean"
    ) throw new Error("Недопустимый scenario");
  }
}
export function validateConfig(value: unknown): PerformanceConfig {
  const checked = parseConfig(value);
  if (
    !Array.isArray(checked.scenarios) ||
    !checked.scenarios.length
  ) throw new Error("Отсутствуют scenarios");
  if (checked.schema_version !== 2) throw new Error("Необходима конфигурация v2");
  if (!/^[\w.-]+\/[\w.-]+$/.test(checked.projectSource)) {
    throw new Error("Недопустимый projectSource");
  }
  if (
    checked.outputPolicy !== undefined &&
    !["strict", "java-pilot-core-qrc-v1"].includes(checked.outputPolicy)
  ) throw new Error("Недопустимая outputPolicy");
  if (
    checked.benchmark !== undefined &&
    (!Number.isFinite(checked.benchmark.maxSlowdownRatio) ||
      checked.benchmark.maxSlowdownRatio <= 0 ||
      checked.benchmark.pairs !== undefined &&
        (!Number.isInteger(checked.benchmark.pairs) || checked.benchmark.pairs < 1))
  ) throw new Error("Необходим явный benchmark maxSlowdownRatio и положительное pairs");
  validateScenarios(checked);
  return {
    ...checked,
    outputPolicy: checked.outputPolicy ?? "strict",
    ...(checked.benchmark
      ? { benchmark: { ...checked.benchmark, pairs: checked.benchmark.pairs ?? 10 } }
      : {}),
  };
}
