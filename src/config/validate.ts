import { isAbsolute } from "node:path";
import type { Scenario, SourceRequest } from "./types.ts";
export interface PerformanceConfig {
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
  const ids = new Set<string>();
  for (const s of c.scenarios) {
    if (!/^[\w-]+$/.test(s.id) || ids.has(s.id)) {
      throw new Error("Повтор или некорректный scenario id");
    }
    ids.add(s.id);
    if (
      isAbsolute(s.cwd) || s.cwd.split(/[\\/]/).includes("..") || s.executable !== "quarto" ||
      !Array.isArray(s.args) || s.args.some((x) => typeof x !== "string") ||
      !["off", "summary", "cpu", "trace"].includes(s.mode) ||
      !["clean-output", "repeat-render"].includes(s.cachePolicy) ||
      !["student", "full"].includes(s.courseProfile) || s.project !== "Java" ||
      !Array.isArray(s.scope?.modules) || !Array.isArray(s.scope?.extensions) ||
      typeof s.scope.strict !== "boolean" || typeof s.resources?.wall !== "boolean"
    ) throw new Error("Недопустимый scenario");
  }
  return c;
}
