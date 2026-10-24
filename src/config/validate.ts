import { isAbsolute } from "node:path";
import {
  type OutputPolicy,
  type Replacement,
  type Scenario,
  type SourceRequest,
  validateSourceSelection,
} from "./types.ts";
export interface PerformanceConfig {
  schema_version: 2;
  projectSource: string;
  replacements: Replacement[];
  benchmark?: { pairs?: number; maxSlowdownRatio: number };
  outputPolicy?: OutputPolicy;
  sources: SourceRequest[];
  scenarios: Scenario[];
  cleanPaths?: string[];
  runtime?: { quarto?: string };
}
export function validateConfig(value: unknown): PerformanceConfig {
  if (!value || typeof value !== "object") throw new Error("Конфигурация должна быть объектом");
  const c = value as PerformanceConfig;
  if (
    !Array.isArray(c.sources) || !Array.isArray(c.scenarios) || !c.sources.length ||
    !c.scenarios.length
  ) throw new Error("Отсутствуют sources/scenarios");
  if (c.schema_version !== 2) throw new Error("Необходима конфигурация v2");
  const repos = new Set<string>();
  for (const s of c.sources) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(s.repository) || repos.has(s.repository)) {
      throw new Error("Недопустимый repository");
    }
    repos.add(s.repository);
    if (
      !["remote-default-head", "explicit-remote-ref"].includes(s.refPolicy) ||
      s.refPolicy === "explicit-remote-ref" && !s.ref?.startsWith("refs/")
    ) throw new Error("Explicit ref отсутствует или некорректен");
  }
  validateSourceSelection(c);
  if (
    c.outputPolicy !== undefined && !["strict", "java-pilot-core-qrc-v1"].includes(c.outputPolicy)
  ) throw new Error("Недопустимая outputPolicy");
  if (
    c.benchmark !== undefined &&
    (!Number.isFinite(c.benchmark.maxSlowdownRatio) || c.benchmark.maxSlowdownRatio <= 0 ||
      c.benchmark.pairs !== undefined &&
        (!Number.isInteger(c.benchmark.pairs) || c.benchmark.pairs < 1))
  ) throw new Error("Необходим явный benchmark maxSlowdownRatio и положительное pairs");
  const ids = new Set<string>();
  for (const s of c.scenarios) {
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
  return {
    ...c,
    outputPolicy: c.outputPolicy ?? "strict",
    ...(c.benchmark ? { benchmark: { ...c.benchmark, pairs: c.benchmark.pairs ?? 10 } } : {}),
  };
}
