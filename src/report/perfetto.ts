import {
  type NormalizedRun,
  operationAttribution,
  validatedIntervals,
} from "../analysis/normalize.ts";
export function traces(run: NormalizedRun) {
  type TraceEvent = {
    name: string;
    cat: string;
    ph: string;
    ts: number;
    dur: number;
    pid: string;
    tid: string;
    args: Record<string, unknown>;
  };
  const wall: { traceEvents: TraceEvent[]; displayTimeUnit: string } = {
      traceEvents: [],
      displayTimeUnit: "ms",
    },
    luaCpu: { traceEvents: TraceEvent[]; displayTimeUnit: string } = {
      traceEvents: [],
      displayTimeUnit: "ms",
    };
  const origins = Object.values(run.executors).map((x) =>
    (x.calibration as { time_origin_ms?: number } | undefined)?.time_origin_ms
  ).filter((x): x is number => typeof x === "number");
  const zero = origins.length ? Math.min(...origins) : 0;
  for (const { begin: start, end: e, durationUs } of validatedIntervals(run)) {
    const executor = run.executors[`${start.process_id}/${start.executor_id}`],
      calibration = executor?.calibration as
        | { time_origin_ms?: number; uncertainty_us?: number }
        | undefined;
    const shift = start.clock_domain === "monotonic_process" && calibration?.time_origin_ms
      ? (calibration.time_origin_ms - zero) * 1000
      : 0;
    const row: TraceEvent = {
      name: start.operation_id!,
      cat: start.kind,
      ph: "X",
      ts: start.timestamp_us! + shift,
      dur: durationUs,
      pid: start.process_id,
      tid: start.executor_id,
      args: {
        run_id: run.runId,
        document_id: start.document_id ?? null,
        ...operationAttribution(start),
        clock_domain: start.clock_domain,
        parent_span_id: start.parent_span_id ?? null,
        status: e.status,
        self_time: "not-available",
        clock_alignment: calibration ? "calibrated" : "local-executor-only",
        uncertainty_us: calibration?.uncertainty_us ?? null,
      },
    };
    (start.clock_domain === "process_cpu" ? luaCpu : wall).traceEvents.push(row);
  }
  return { wall, luaCpu };
}
