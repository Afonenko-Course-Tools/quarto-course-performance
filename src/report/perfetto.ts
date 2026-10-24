import {
  type NormalizedRun,
  operationAttribution,
  validatedEvents,
  type ValidatedInterval,
  validatedIntervals,
} from "../analysis/normalize.ts";

export interface ChromeTraceEvent {
  ph: "M" | "X" | "s" | "f";
  name: string;
  pid: number;
  tid: number;
  ts?: number;
  dur?: number;
  id?: number;
  cat?: string;
  args: Record<string, unknown>;
}
export interface ChromeTrace {
  traceEvents: ChromeTraceEvent[];
  displayTimeUnit: "ms";
}
export interface TraceBundle {
  wall: ChromeTrace;
  luaCpu: ChromeTrace;
  localWall: { fileName: string; trace: ChromeTrace }[];
}
const empty = (): ChromeTrace => ({ traceEvents: [], displayTimeUnit: "ms" });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const executorKey = (e: ValidatedInterval["begin"]) =>
  JSON.stringify([e.process_id, e.executor_id]);
function origin(run: NormalizedRun, interval: ValidatedInterval): number | undefined {
  const e = interval.begin;
  const calibration = run.executors[`${e.process_id}/${e.executor_id}`]?.calibration as {
    time_origin_ms?: number;
  } | undefined;
  const value = calibration?.time_origin_ms;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Дорожки логические; только явно записанное родительство разрешает вложенность. */
export function traces(
  run: NormalizedRun,
  processes: ReadonlyArray<Record<string, unknown>> = [],
): TraceBundle {
  const bundle: TraceBundle = { wall: empty(), luaCpu: empty(), localWall: [] };
  const intervals = validatedIntervals(run);
  const groups = new Map<string, ValidatedInterval[]>();
  for (const interval of intervals) {
    const key = executorKey(interval.begin);
    const rows = groups.get(key) ?? [];
    rows.push(interval);
    groups.set(key, rows);
  }
  const keys = [...groups.keys()].sort(compare);
  const pids = [...new Set(intervals.map((i) => i.begin.process_id))].sort(compare);
  const origins = intervals.filter((i) => i.begin.clock_domain === "monotonic_process")
    .map((i) => origin(run, i)).filter((n): n is number => n !== undefined);
  const zero = origins.length ? Math.min(...origins) : 0;
  const bySpan = new Map(intervals.map((i) => [i.begin.span_id!, i]));
  const placed = new Map<string, { trace: ChromeTrace; event: ChromeTraceEvent }>();
  const initialized = new Set<ChromeTrace>();
  const processMetadata = new Map<ChromeTrace, Set<number>>();
  let tid = 0;
  function metadata(
    trace: ChromeTrace,
    pid: number,
    name: string,
    args: Record<string, unknown>,
    track = 0,
  ) {
    trace.traceEvents.push({ ph: "M", name, pid, tid: track, args });
  }
  function ancestor(parent: ValidatedInterval, child: ValidatedInterval): boolean {
    const seen = new Set<string>();
    let id = child.begin.parent_span_id;
    while (id && !seen.has(id)) {
      if (id === parent.begin.span_id) return true;
      seen.add(id);
      const next = bySpan.get(id);
      if (!next || executorKey(next.begin) !== executorKey(child.begin)) return false;
      id = next.begin.parent_span_id;
    }
    return false;
  }
  for (const key of keys) {
    const rows = groups.get(key)!.sort((a, b) =>
      a.begin.timestamp_us! - b.begin.timestamp_us! || b.end.timestamp_us! - a.end.timestamp_us! ||
      compare(a.begin.span_id!, b.begin.span_id!)
    );
    const first = rows[0].begin;
    const calibration = origin(run, rows[0]);
    const isWall = first.clock_domain === "monotonic_process";
    let trace: ChromeTrace;
    if (!isWall) trace = bundle.luaCpu;
    else if (calibration !== undefined) trace = bundle.wall;
    else {
      trace = empty();
      bundle.localWall.push({
        fileName: `local-wall-${String(bundle.localWall.length + 1).padStart(3, "0")}.trace.json`,
        trace,
      });
    }
    const pid = pids.indexOf(first.process_id) + 1;
    if (!initialized.has(trace)) {
      initialized.add(trace);
      metadata(trace, pid, "course_perf_quality", {
        run_id: run.runId,
        data_valid: run.dataValid,
        coverage_complete: run.quality.coverageComplete,
        quality: run.quality,
        excluded_spans: validatedEvents(run).filter((e) => e.span_id && !bySpan.has(e.span_id)).map(
          (e) => ({
            process_id: e.process_id,
            executor_id: e.executor_id,
            span_id: e.span_id,
            event: e.event,
            status: e.status ?? null,
          }),
        ),
      });
    }
    const known = processMetadata.get(trace) ?? new Set<number>();
    if (!known.has(pid)) {
      known.add(pid);
      processMetadata.set(trace, known);
      const receipts = processes.filter((p) => p.process_id === first.process_id);
      metadata(trace, pid, "process_name", {
        name: `Процесс ${first.process_id}`,
        process_id: first.process_id,
        receipts,
      });
    }
    const lanes: { tid: number; intervals: ValidatedInterval[] }[] = [];
    for (const interval of rows) {
      const { begin, end, durationUs } = interval;
      let lane = lanes.find((l) =>
        l.intervals.every((other) =>
          other.end.timestamp_us! <= begin.timestamp_us! ||
          end.timestamp_us! <= other.begin.timestamp_us! ||
          (other.begin.timestamp_us! <= begin.timestamp_us! &&
            end.timestamp_us! <= other.end.timestamp_us! &&
            ancestor(other, interval))
        )
      );
      if (!lane) {
        lane = { tid: ++tid, intervals: [] };
        lanes.push(lane);
        metadata(trace, pid, "thread_name", {
          name: `${first.executor_id}: логическая дорожка ${lanes.length}${
            isWall ? "" : " (локальное CPU Lua)"
          }`,
          process_id: first.process_id,
          executor_id: first.executor_id,
          clock_domain: first.clock_domain,
          logical_lane: lanes.length,
        }, lane.tid);
      }
      lane.intervals.push(interval);
      const alignment = isWall && calibration !== undefined ? "calibrated" : "local-executor-only";
      const executor = run.executors[`${begin.process_id}/${begin.executor_id}`];
      const row: ChromeTraceEvent = {
        name: begin.operation_id!,
        cat: begin.kind,
        ph: "X",
        pid,
        tid: lane.tid,
        ts: begin.timestamp_us! + (alignment === "calibrated" ? (calibration! - zero) * 1000 : 0),
        dur: durationUs,
        args: {
          run_id: run.runId,
          process_id: begin.process_id,
          executor_id: begin.executor_id,
          span_id: begin.span_id,
          parent_span_id: begin.parent_span_id ?? null,
          document_id: begin.document_id ?? null,
          symbol_id: begin.symbol_id ?? null,
          operation_id: begin.operation_id,
          origin: begin.origin,
          status: end.status,
          ...operationAttribution(begin),
          source_attributes: begin.attributes ?? {},
          source_end_attributes: end.attributes ?? {},
          clock_domain: begin.clock_domain,
          clock_alignment: alignment,
          uncertainty_us:
            (executor?.calibration as { uncertainty_us?: number } | undefined)?.uncertainty_us ??
              null,
          self_time: "not-available",
          data_valid: run.dataValid,
          coverage_complete: run.quality.coverageComplete,
        },
      };
      trace.traceEvents.push(row);
      placed.set(begin.span_id!, { trace, event: row });
    }
  }
  let flowId = 0;
  for (const id of [...placed.keys()].sort(compare)) {
    const child = placed.get(id)!;
    const parentId = bySpan.get(id)!.begin.parent_span_id;
    const parent = parentId ? placed.get(parentId) : undefined;
    if (
      !parent || child.trace !== bundle.wall || parent.trace !== bundle.wall ||
      parent.event.ts! > child.event.ts! || parentId === id
    ) continue;
    // Циклическое отношение не является подтверждённой причинной связью.
    let cursor: string | undefined = parentId;
    const seen = new Set([id]);
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = bySpan.get(cursor)?.begin.parent_span_id;
    }
    if (cursor) continue;
    const args = {
      relationship: "logical-parent",
      run_id: run.runId,
      parent_span_id: parentId,
      span_id: id,
      parent_process_id: parent.event.args.process_id,
      process_id: child.event.args.process_id,
      meaning: "Логическая связь; время передачи управления не измерено",
    };
    const linkId = ++flowId;
    for (const [ph, anchor] of [["s", parent.event], ["f", child.event]] as const) {
      bundle.wall.traceEvents.push({
        ph,
        name: "Логическое родительство",
        cat: "logical-parent",
        id: linkId,
        pid: anchor.pid,
        tid: anchor.tid,
        ts: anchor.ts,
        args,
      });
    }
  }
  return bundle;
}
