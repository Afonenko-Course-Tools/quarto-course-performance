import type { Event } from "../../../../src/protocol/types.ts";
import type { NormalizedRun } from "../../../../src/analysis/normalize.ts";

// Контрольные данные экспортёра, не измерение курса.
export function pair(
  id: string,
  start: number,
  end: number,
  context: Partial<Event> = {},
): Event[] {
  const base: Event = {
    schema_version: 1,
    experiment_id: "control",
    run_id: "fixture",
    process_id: "00000000-0000-4000-8000-000000000001",
    executor_id: "ts",
    event: "begin",
    kind: "function",
    origin: "manual",
    clock_domain: "monotonic_process",
    span_id: id,
    operation_id: id,
    sequence: 1,
    ...context,
  };
  return [{ ...base, timestamp_us: start }, {
    ...base,
    event: "end",
    sequence: 2,
    timestamp_us: end,
    status: "ok",
  }];
}
export function run(events: Event[], calibration: unknown = { time_origin_ms: 0 }): NormalizedRun {
  return {
    runId: "fixture",
    experimentId: "control",
    events,
    dataValid: true,
    quality: { droppedEvents: 0, incompleteSpans: 0, coverageComplete: false, errors: [] },
    executors: Object.fromEntries(events.map((e) => [`${e.process_id}/${e.executor_id}`, {
      process_id: e.process_id,
      executor_id: e.executor_id,
      clock_domain: e.clock_domain,
      calibration: e.clock_domain === "monotonic_process" ? calibration : undefined,
      counters: {},
    }])),
  };
}
export function controlRun(): NormalizedRun {
  const result = run([
    ...pair("parent", 0, 100),
    ...pair("child", 10, 20, { parent_span_id: "parent" }),
    ...pair("async-a", 30, 60),
    ...pair("async-b", 40, 70),
    ...pair("remote", 50, 80, {
      process_id: "00000000-0000-4000-8000-000000000002",
      parent_span_id: "parent",
      document_id: "nested/slides.qmd",
      attributes: { extension_id: "course-core" },
    }),
    ...pair("lua", 5, 15, { executor_id: "lua", clock_domain: "process_cpu" }),
    ...pair("local", 1, 9, { executor_id: "uncalibrated" }),
    ...pair("error", 110, 120).map((e) =>
      e.event === "end" ? { ...e, status: "error" as const } : e
    ),
  ].filter(Boolean));
  result.executors["00000000-0000-4000-8000-000000000001/uncalibrated"].calibration = undefined;
  return result;
}
