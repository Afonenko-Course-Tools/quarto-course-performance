import { numberMap, strings } from "../json.ts";
import type { Event } from "../protocol/types.ts";
import type { NormalizeState } from "./normalize-state.ts";
export function validateNormalizeSpans(state: NormalizeState) {
  const sequence = new Map<string, number>(),
    open = new Map<string, Event>(),
    seen = new Set<string>(),
    parents = new Map<string, string | undefined>();
  for (const e of state.events) {
    const key = `${e.process_id}/${e.executor_id}`, last = sequence.get(key) ?? 0;
    if (e.sequence !== last + 1) {
      state.quality.errors.push(`Пропуск/повтор sequence: ${key} ${e.sequence}`);
    }
    sequence.set(key, e.sequence);
    if (e.event === "begin") {
      if (seen.has(e.span_id!)) state.quality.errors.push(`Повтор span ${e.span_id}`);
      seen.add(e.span_id!);
      parents.set(e.span_id!, e.parent_span_id);
      open.set(e.span_id!, e);
    }
    if (e.event === "end") {
      const begin = open.get(e.span_id!);
      if (
        !begin || begin.executor_id !== e.executor_id || begin.process_id !== e.process_id ||
        begin.clock_domain !== e.clock_domain || begin.operation_id !== e.operation_id ||
        e.timestamp_us! < begin.timestamp_us!
      ) state.quality.errors.push(`Несогласованный end ${e.span_id}`);
      else open.delete(e.span_id!);
    }
  }
  state.quality.incompleteSpans = Math.max(
    open.size + state.events.filter((e) => e.event === "end" && e.status === "aborted").length,
    state.quality.incompleteSpans,
  );
  const done = new Set<string>();
  for (const id of parents.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current && !done.has(current)) {
      if (visited.has(current)) {
        state.quality.errors.push(`Цикл parent spans: ${id}`);
        break;
      }
      visited.add(current);
      current = parents.get(current);
    }
    for (const key of visited) done.add(key);
  }
  for (const e of state.events) {
    const summary = state.executors[`${e.process_id}/${e.executor_id}`];
    if (!summary || e.clock_domain !== "none" && summary.clock_domain !== e.clock_domain) {
      state.quality.errors.push(
        `Отсутствует/не совпадает executor summary: ${e.process_id}/${e.executor_id}`,
      );
    }
    if (e.parent_span_id && !seen.has(e.parent_span_id)) {
      state.quality.errors.push(`Неподтверждённый parent ${e.parent_span_id}`);
    }
  }
}
export function validateNormalizeProcesses(state: NormalizeState) {
  for (const process of state.processes) {
    if (process.expectation && process.exit_code === null) {
      state.quality.errors.push(`Нет подтверждённого завершения процесса: ${process.process_id}`);
    }
    if (process.signal) {
      state.quality.errors.push(`Процесс прерван: ${process.process_id} ${process.signal}`);
    }
    // Только исторический импорт без v2 receipt использует прежнюю эвристику argv.
    if (state.expectations) continue;
    const argv = Array.isArray(process.argv) ? strings(process.argv) : [];
    if (
      process.kind === "pandoc" && argv.some((a) =>
        a === "--lua-filter" || a.startsWith("--lua-filter=")
      ) &&
      !Object.values(state.executors).some((e) =>
        e.process_id === process.process_id && e.clock_domain === "process_cpu"
      )
    ) state.quality.errors.push(`Отсутствует Lua child summary: ${process.process_id}`);
    if (
      process.kind === "deno" && argv[0] === "run" && !state.executors[`${process.process_id}/ts`]
    ) state.quality.errors.push(`Отсутствует child summary: ${process.process_id}`);
  }
}
export function validateNormalizeCounters(state: NormalizeState) {
  const deltas = new Map<
    string,
    { process: string; executor: string; name: string; value: number }
  >();
  for (const event of state.events) {
    if (
      event.event !== "counter" || !event.counter || event.run_id !== state.runId ||
      event.experiment_id !== state.experimentId
    ) continue;
    const key = JSON.stringify([event.process_id, event.executor_id, event.counter.name]);
    const delta = deltas.get(key) ?? {
      process: event.process_id,
      executor: event.executor_id,
      name: event.counter.name,
      value: 0,
    };
    delta.value += event.counter.value;
    deltas.set(key, delta);
  }
  for (const delta of deltas.values()) {
    const rawTotals = state.executors[`${delta.process}/${delta.executor}`]?.counters;
    const totals = rawTotals === undefined ? undefined : numberMap(rawTotals);
    // Отсутствие события/total не означает нулевое наблюдение. Два источника
    // сохраняются отдельно даже при потере журнала и никогда не складываются.
    if (totals && Object.hasOwn(totals, delta.name) && totals[delta.name] !== delta.value) {
      state.quality.errors.push(
        `Counter ${delta.process}/${delta.executor}/${delta.name}: delta=${delta.value}, total=${
          totals[delta.name]
        }`,
      );
    }
  }
}
