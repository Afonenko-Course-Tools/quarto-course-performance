// Самодостаточный фасад ABI 1. Копировать только из канонического шаблона Performance.
export interface OperationSpec {
  id: string;
  kind: "phase" | "function" | "ast_walk" | "io" | "command";
  symbol_id?: string;
  document_id?: string;
  attributes?: Record<string, string | number | boolean | null>;
  origin?: "manual" | "auto" | "runtime";
}
export interface WalkSpec extends OperationSpec {
  kind: "ast_walk";
  scope: "full-document" | "fragment" | "block" | "inline" | "unknown";
}
export interface Metrics {
  wrapSync<This, Args extends unknown[], Result>(
    spec: OperationSpec,
    fn: (this: This, ...args: Args) => Result,
  ): (this: This, ...args: Args) => Result;
  wrapAsync<This, Args extends unknown[], Result>(
    spec: OperationSpec,
    fn: (this: This, ...args: Args) => Promise<Result>,
  ): (this: This, ...args: Args) => Promise<Result>;
  wrapWalk<This, Args extends unknown[], Result>(
    spec: WalkSpec,
    fn: (this: This, ...args: Args) => Result,
  ): (this: This, ...args: Args) => Result;
  childEnv(base: Record<string, string>): Record<string, string>;
}
const identity: Metrics = {
  wrapSync: (_spec, fn) => fn,
  wrapAsync: (_spec, fn) => fn,
  wrapWalk: (_spec, fn) => fn,
  childEnv: (base) => base,
};
function isMetrics(value: unknown): value is Metrics {
  return value !== null && typeof value === "object" &&
    "wrapSync" in value && typeof value.wrapSync === "function" &&
    "wrapAsync" in value && typeof value.wrapAsync === "function" &&
    "wrapWalk" in value && typeof value.wrapWalk === "function" &&
    "childEnv" in value && typeof value.childEnv === "function";
}
export function createMetrics(extensionId: string, abiVersion: 1 = 1): Metrics {
  let mode: string | undefined;
  try {
    mode = Deno.env.get("COURSE_PERF_MODE");
  } catch {
    return identity;
  }
  if (!mode || mode === "off") return identity;
  const registry = globalThis as Record<symbol, unknown>;
  const agent = registry[Symbol.for("course.performance.agent.v1")];
  if (
    agent !== null && typeof agent === "object" &&
    "abiVersion" in agent && agent.abiVersion === abiVersion &&
    "metrics" in agent && isMetrics(agent.metrics)
  ) {
    const metrics = agent.metrics;
    const bound = <T extends OperationSpec>(spec: T): T => ({
      ...spec,
      attributes: { ...spec.attributes, extension_id: extensionId },
    });
    return {
      wrapSync: (spec, fn) => metrics.wrapSync(bound(spec), fn),
      wrapAsync: (spec, fn) => metrics.wrapAsync(bound(spec), fn),
      wrapWalk: (spec, fn) => metrics.wrapWalk(bound(spec), fn),
      childEnv: (base) => metrics.childEnv(base),
    };
  }
  const failures = Symbol.for("course.performance.failures.v1");
  const recordedFailures = registry[failures] ??= [];
  if (!Array.isArray(recordedFailures)) {
    throw new TypeError("Некорректный реестр ошибок Performance ABI 1");
  }
  recordedFailures.push(
    `${extensionId}: агент ABI ${abiVersion} отсутствует или несовместим`,
  );
  return identity;
}
