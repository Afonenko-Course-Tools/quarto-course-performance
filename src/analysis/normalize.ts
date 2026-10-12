import { join } from "node:path";
import { files } from "../sources/snapshot.ts";
import type { Event } from "../protocol/types.ts";
import { validateEvent } from "../protocol/validate.ts";
export interface QualitySummary {
  droppedEvents: number;
  incompleteSpans: number;
  coverageComplete: boolean;
  errors: string[];
}
export interface NormalizedRun {
  runId: string;
  events: Event[];
  dataValid: boolean;
  quality: QualitySummary;
  executors: Record<string, Record<string, unknown>>;
}
export async function normalizeRun(directory: string): Promise<NormalizedRun> {
  const events: Event[] = [],
    quality: QualitySummary = {
      droppedEvents: 0,
      incompleteSpans: 0,
      coverageComplete: true,
      errors: [],
    },
    executors: Record<string, Record<string, unknown>> = {};
  let runId = "";
  let experimentId = "";
  try {
    const identity = JSON.parse(await Deno.readTextFile(join(directory, "mode.json")));
    runId = identity.runId ?? "";
    experimentId = identity.experimentId ?? "";
  } catch { /* Старые fixture не имеют receipt. */ }
  let entries: string[] = [];
  try {
    entries = await files(join(directory, "events"));
  } catch (e) {
    quality.errors.push(`Журналы отсутствуют: ${String(e)}`);
  }
  let summaries = 0;
  for (const path of entries) {
    if (path.endsWith(".summary.json")) {
      try {
        const s = JSON.parse(await Deno.readTextFile(path));
        if (
          s.schema_version !== 1 || !s.run_id || !s.experiment_id || !s.process_id ||
          !s.executor_id ||
          !["monotonic_process", "process_cpu"].includes(s.clock_domain) ||
          !Number.isSafeInteger(s.dropped_events) || s.dropped_events < 0 ||
          !Number.isSafeInteger(s.incomplete_spans) || s.incomplete_spans < 0 ||
          !s.counters || Object.values(s.counters).some((n) =>
            typeof n !== "number" || !Number.isFinite(n) || n < 0
          )
        ) {
          throw new Error("Некорректный schema/counters/quality summary");
        }
        if (runId && s.run_id !== runId || experimentId && s.experiment_id !== experimentId) {
          throw new Error("Смешаны run/experiment summary");
        }
        runId = s.run_id;
        experimentId = s.experiment_id;
        if (executors[`${s.process_id}/${s.executor_id}`]) {
          throw new Error("Повтор executor summary");
        }
        summaries++;
        quality.droppedEvents += s.dropped_events ?? 0;
        quality.incompleteSpans += s.incomplete_spans ?? 0;
        quality.errors.push(...s.errors ?? [], ...s.abi_failures ?? []);
        if (!s.data_valid) {
          quality.errors.push(`Невалидный executor ${path}`);
        }
        executors[`${s.process_id}/${s.executor_id}`] = s;
      } catch (e) {
        quality.errors.push(`Summary ${path}: ${String(e)}`);
      }
    } else if (path.endsWith(".jsonl")) {
      for (const line of (await Deno.readTextFile(path)).split("\n").filter(Boolean)) {
        try {
          const e = validateEvent(JSON.parse(line));
          if (runId && e.run_id !== runId) throw new Error("Смешаны run_id");
          if (experimentId && e.experiment_id !== experimentId) {
            throw new Error("Смешаны experiment_id");
          }
          runId = e.run_id;
          experimentId = e.experiment_id;
          events.push(e);
        } catch (e) {
          quality.errors.push(`Event ${path}: ${String(e)}`);
        }
      }
    }
  }
  if (!summaries) quality.errors.push("Нет итогов executors");
  const sequence = new Map<string, number>(),
    open = new Map<string, Event>(),
    seen = new Set<string>(),
    parents = new Map<string, string | undefined>();
  for (const e of events) {
    const key = `${e.process_id}/${e.executor_id}`, last = sequence.get(key) ?? 0;
    if (e.sequence !== last + 1) {
      quality.errors.push(`Пропуск/повтор sequence: ${key} ${e.sequence}`);
    }
    sequence.set(key, e.sequence);
    if (e.event === "begin") {
      if (seen.has(e.span_id!)) quality.errors.push(`Повтор span ${e.span_id}`);
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
      ) quality.errors.push(`Несогласованный end ${e.span_id}`);
      else open.delete(e.span_id!);
    }
  }
  quality.incompleteSpans = Math.max(open.size, quality.incompleteSpans);
  const done = new Set<string>();
  for (const id of parents.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current && !done.has(current)) {
      if (visited.has(current)) {
        quality.errors.push(`Цикл parent spans: ${id}`);
        break;
      }
      visited.add(current);
      current = parents.get(current);
    }
    for (const key of visited) done.add(key);
  }
  for (const e of events) {
    const summary = executors[`${e.process_id}/${e.executor_id}`];
    if (!summary || e.clock_domain !== "none" && summary.clock_domain !== e.clock_domain) {
      quality.errors.push(
        `Отсутствует/не совпадает executor summary: ${e.process_id}/${e.executor_id}`,
      );
    }
    if (e.parent_span_id && !seen.has(e.parent_span_id)) {
      const executor = executors[`${e.process_id}/${e.executor_id}`];
      if (executor?.parent_link !== "confirmed") {
        quality.errors.push(`Неподтверждённый parent ${e.parent_span_id}`);
      }
    }
  }
  try {
    const c = JSON.parse(await Deno.readTextFile(join(directory, "coverage.json")));
    quality.coverageComplete = c.complete === true;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) quality.errors.push(`Coverage: ${String(e)}`);
  }
  try {
    const invalid = JSON.parse(await Deno.readTextFile(join(directory, "invalidated.json")));
    quality.errors.push(`Измерение отозвано: ${invalid.reason}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) quality.errors.push(`Invalidation: ${String(e)}`);
  }
  let mode = "";
  try {
    mode = JSON.parse(await Deno.readTextFile(join(directory, "mode.json"))).mode;
  } catch { /* Ранее записанные raw данные не требуют этого receipt. */ }
  try {
    for await (const entry of Deno.readDir(join(directory, "processes"))) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const process = JSON.parse(await Deno.readTextFile(join(directory, "processes", entry.name)));
      if (process.kind === "deno" && process.argv[0] === "run") {
        if (!executors[`${process.process_id}/ts`]) {
          quality.errors.push(`Отсутствует child summary: ${process.process_id}`);
        }
        if (mode === "cpu") {
          try {
            const profile = JSON.parse(
              await Deno.readTextFile(
                join(directory, "profiles", process.process_id, "cpu.cpuprofile"),
              ),
            );
            if (
              !Array.isArray(profile.nodes) || !(profile.endTime >= profile.startTime)
            ) throw new Error("Некорректный CPU profile");
          } catch (e) {
            quality.errors.push(`CPU ${process.process_id}: ${String(e)}`);
          }
        }
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) quality.errors.push(`Processes: ${String(e)}`);
  }
  return {
    runId,
    events,
    dataValid: !quality.droppedEvents && !quality.incompleteSpans && !quality.errors.length,
    quality,
    executors,
  };
}
