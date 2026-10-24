import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import type { Mode } from "../../config/types.ts";
import type { Event, Metrics, OperationSpec, WalkSpec } from "../../protocol/types.ts";
export interface AgentConfig {
  experimentId: string;
  runId: string;
  processId: string;
  outputDirectory: string;
  mode: Mode;
  maxEvents?: number;
  executorId?: string;
}
export function installTsAgent(config: AgentConfig) {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  const context = new AsyncLocalStorage<string>();
  const events: Event[] = [];
  const counters: Record<string, number> = {};
  const active = new Set<string>();
  const errors: string[] = [];
  let sequence = 0, serial = 0, dropped = 0;
  const executorId = config.executorId ?? "ts";
  const timestamp = () => performance.now() * 1000;
  try {
    const directory = join(config.outputDirectory, "events", config.processId);
    Deno.mkdirSync(directory, { recursive: true });
    Deno.writeTextFileSync(
      join(directory, `${executorId}.started.json`),
      JSON.stringify({
        schema_version: 1,
        process_id: config.processId,
        executor_id: executorId,
        agent: "ts",
        executed: true,
      }),
    );
  } catch (e) {
    errors.push(`activation: ${String(e)}`);
  }
  function emit(
    event: Omit<
      Event,
      "schema_version" | "experiment_id" | "run_id" | "process_id" | "executor_id" | "sequence"
    >,
  ) {
    try {
      const row: Event = {
        schema_version: 1,
        experiment_id: config.experimentId,
        run_id: config.runId,
        process_id: config.processId,
        executor_id: executorId,
        sequence: ++sequence,
        ...event,
      };
      if (events.length < (config.maxEvents ?? 200000)) events.push(row);
      else dropped++;
    } catch (e) {
      errors.push(String(e));
    }
  }
  function begin(spec: OperationSpec) {
    const id = `${config.processId}-${executorId}-${++serial}`;
    const parent = context.getStore() ?? Deno.env.get("COURSE_PERF_PARENT_SPAN_ID");
    counters[`calls.${spec.id}`] = (counters[`calls.${spec.id}`] ?? 0) + 1;
    if (spec.kind === "ast_walk") {
      const key = `walk_api_calls.${(spec as WalkSpec).scope}`;
      counters[key] = (counters[key] ?? 0) + 1;
      emit({
        event: "counter",
        document_id: spec.document_id,
        attributes: spec.attributes ? { ...spec.attributes } : undefined,
        kind: "ast_walk",
        origin: spec.origin ?? "manual",
        clock_domain: "none",
        counter: { name: key, value: 1, quality: "observed-exact" },
      });
    }
    active.add(id);
    emit({
      event: "begin",
      kind: spec.kind,
      span_id: id,
      parent_span_id: parent,
      operation_id: spec.id,
      symbol_id: spec.symbol_id,
      document_id: spec.document_id,
      attributes: spec.attributes ? { ...spec.attributes } : undefined,
      origin: spec.origin ?? "manual",
      clock_domain: "monotonic_process",
      timestamp_us: timestamp(),
    });
    return id;
  }
  function end(id: string, spec: OperationSpec, status: "ok" | "error") {
    active.delete(id);
    emit({
      event: "end",
      kind: spec.kind,
      span_id: id,
      operation_id: spec.id,
      document_id: spec.document_id,
      attributes: spec.attributes ? { ...spec.attributes } : undefined,
      origin: spec.origin ?? "manual",
      clock_domain: "monotonic_process",
      timestamp_us: timestamp(),
      status,
    });
  }
  function safeBegin(spec: OperationSpec): string | undefined {
    try {
      return begin(spec);
    } catch (e) {
      errors.push(`begin: ${String(e)}`);
      return undefined;
    }
  }
  function safeEnd(id: string | undefined, spec: OperationSpec, status: "ok" | "error") {
    if (id) {
      try {
        end(id, spec, status);
      } catch (e) {
        errors.push(`end: ${String(e)}`);
      }
    }
  }
  // deno-lint-ignore no-explicit-any
  type Fn = (...args: any[]) => any;
  function wrapSync<T extends Fn>(spec: OperationSpec, fn: T): T {
    return function (this: unknown, ...args: unknown[]) {
      const id = safeBegin(spec);
      const call = () => {
        try {
          const value = fn.apply(this, args);
          safeEnd(id, spec, "ok");
          return value;
        } catch (error) {
          safeEnd(id, spec, "error");
          throw error;
        }
      };
      return id ? context.run(id, call) : call();
    } as T;
  }
  function wrapAsync<T extends Fn>(spec: OperationSpec, fn: T): T {
    return function (this: unknown, ...args: unknown[]) {
      const id = safeBegin(spec);
      const call = async () => {
        try {
          const value = await fn.apply(this, args);
          safeEnd(id, spec, "ok");
          return value;
        } catch (error) {
          safeEnd(id, spec, "error");
          throw error;
        }
      };
      return id ? context.run(id, call) : call();
    } as T;
  }
  const metrics: Metrics = {
    wrapSync,
    wrapAsync,
    wrapWalk: wrapSync,
    childEnv(base) {
      const env: Record<string, string> = {
        ...base,
        COURSE_PERF_PARENT_PROCESS_ID: config.processId,
      };
      delete env.COURSE_PERF_PARENT_SPAN_ID;
      const parent = context.getStore();
      if (parent) env.COURSE_PERF_PARENT_SPAN_ID = parent;
      return env;
    },
  };
  const calibrationBefore = timestamp(), epoch = Date.now(), calibrationAfter = timestamp();
  const calibration = {
    time_origin_ms: performance.timeOrigin,
    wall_epoch_ms: epoch,
    monotonic_us: (calibrationBefore + calibrationAfter) / 2,
    uncertainty_us: 1000 + (calibrationAfter - calibrationBefore) / 2,
    uncertainty_scope: "локальное чтение epoch; системный дрейф не ограничен",
  };
  function flush() {
    const failures = (registry[Symbol.for("course.performance.failures.v1")] ?? []) as string[];
    try {
      const dir = join(config.outputDirectory, "events", config.processId);
      Deno.mkdirSync(dir, { recursive: true });
      Deno.writeTextFileSync(
        join(dir, `${executorId}.jsonl`),
        events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""),
      );
      Deno.writeTextFileSync(
        join(dir, `${executorId}.summary.json`),
        JSON.stringify({
          schema_version: 1,
          experiment_id: config.experimentId,
          run_id: config.runId,
          process_id: config.processId,
          executor_id: executorId,
          os_pid: Deno.pid,
          parent_process_id: Deno.env.get("COURSE_PERF_PARENT_PROCESS_ID") ?? null,
          parent_link: Deno.env.get("COURSE_PERF_PARENT_PROCESS_ID") ? "confirmed" : "unlinked",
          clock_domain: "monotonic_process",
          calibration,
          counters,
          dropped_events: dropped,
          incomplete_spans: active.size,
          errors: [...errors, ...failures],
          data_valid: !dropped && !active.size && !errors.length && !failures.length,
        }),
      );
    } catch (e) {
      errors.push(`flush: ${String(e)}`);
    }
  }
  const agent = { abiVersion: 1, metrics, events, flush };
  registry[Symbol.for("course.performance.agent.v1")] = agent;
  return agent;
}
