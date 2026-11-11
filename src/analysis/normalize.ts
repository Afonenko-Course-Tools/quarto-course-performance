import { join } from "node:path";
import { parseObject } from "../json.ts";
import type { Event } from "../protocol/types.ts";
import { observePackages } from "../runner/package-coverage.ts";
import {
  validateNormalizeCounters,
  validateNormalizeProcesses,
  validateNormalizeSpans,
} from "./normalize-events.ts";
import { validateNormalizeExpectations } from "./normalize-expectations.ts";
import { readNormalizeIdentity, readNormalizeJournals } from "./normalize-journals.ts";
import { createNormalizeState, type NormalizeOptions } from "./normalize-state.ts";
export interface QualitySummary {
  droppedEvents: number;
  incompleteSpans: number;
  coverageComplete: boolean;
  errors: string[];
}
export interface NormalizedRun {
  runId: string;
  experimentId?: string;
  events: Event[];
  dataValid: boolean;
  quality: QualitySummary;
  executors: Record<string, Record<string, unknown>>;
  coverage?: Record<string, unknown>;
}
export interface ValidatedInterval {
  begin: Event;
  end: Event;
  durationUs: number;
}
export function validatedEvents(run: NormalizedRun): Event[] {
  return run.events.filter((event) =>
    event.run_id === run.runId &&
    (!run.experimentId || event.experiment_id === run.experimentId)
  );
}
/** Ровно одна согласованная пара; дубликаты целиком исключают span из производных данных. */
export function validatedIntervals(run: NormalizedRun): ValidatedInterval[] {
  const spans = new Map<string, Event[]>();
  for (const event of validatedEvents(run)) {
    if ((event.event !== "begin" && event.event !== "end") || !event.span_id) continue;
    const rows = spans.get(event.span_id) ?? [];
    rows.push(event);
    spans.set(event.span_id, rows);
  }
  const intervals: ValidatedInterval[] = [];
  for (const rows of spans.values()) {
    if (rows.length !== 2) continue;
    // Порядок хранения журналов не задаёт порядок границ; sequence принадлежит executor.
    const [begin, end] = [...rows].sort((a, b) => a.sequence - b.sequence);
    if (
      !begin || !end || begin.event !== "begin" || end.event !== "end" || end.status === "aborted"
    ) continue;
    if (
      ([
        "experiment_id",
        "run_id",
        "process_id",
        "executor_id",
        "operation_id",
        "clock_domain",
      ] as const).some(
        (key) => begin[key] !== end[key],
      ) || begin.run_id !== run.runId || begin.clock_domain === "none" ||
      end.sequence <= begin.sequence
    ) continue;
    if (
      !Number.isFinite(begin.timestamp_us) || !Number.isFinite(end.timestamp_us) ||
      begin.timestamp_us! < 0 || end.timestamp_us! < begin.timestamp_us!
    ) continue;
    intervals.push({ begin, end, durationUs: end.timestamp_us! - begin.timestamp_us! });
  }
  return intervals;
}
export function operationAttribution(event: Event): {
  extension_id: string | null;
  extension_attribution: "recorded" | "derived" | "unavailable";
} {
  const recorded = event.attributes?.extension_id;
  if (typeof recorded === "string" && recorded) {
    return { extension_id: recorded, extension_attribution: "recorded" };
  }
  const prefix = event.operation_id?.match(/^(course-[^.]+)\./)?.[1];
  return {
    extension_id: prefix ?? null,
    extension_attribution: prefix ? "derived" : "unavailable",
  };
}
export async function normalizeRun(
  directory: string,
  options: NormalizeOptions = {},
): Promise<NormalizedRun> {
  const state = createNormalizeState(options);
  await readNormalizeIdentity(directory, state, options);
  await readNormalizeJournals(directory, state);
  const { events, quality, executors, started } = state;
  let { runId, experimentId, expectations, summaries } = state;
  if (started.length) expectations ??= { schema_version: 2, processes: [] };
  if (!summaries && !expectations) quality.errors.push("Нет итогов executors");
  state.expectations = expectations;
  validateNormalizeSpans(state);
  let coverageInput: Record<string, unknown> | undefined;
  try {
    const c = parseObject(await Deno.readTextFile(join(directory, "coverage.json")));
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("Некорректный coverage");
    coverageInput = c;
    quality.coverageComplete = c.complete === true;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) quality.errors.push(`Coverage: ${String(e)}`);
  }
  try {
    const invalid = parseObject(await Deno.readTextFile(join(directory, "invalidated.json")));
    quality.errors.push(`Измерение отозвано: ${invalid.reason}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) quality.errors.push(`Invalidation: ${String(e)}`);
  }
  await validateNormalizeExpectations(directory, state, options);
  validateNormalizeProcesses(state);
  validateNormalizeCounters(state);
  const dataValid = !quality.droppedEvents && !quality.incompleteSpans && !quality.errors.length;
  quality.coverageComplete &&= dataValid;
  let coverage: Record<string, unknown> | undefined;
  if (coverageInput) {
    const scoped = events.filter((event) =>
      event.run_id === runId && event.experiment_id === experimentId
    );
    coverage = {
      ...coverageInput,
      complete: quality.coverageComplete,
      packageCoverage: observePackages(
        coverageInput.packageCoverage,
        scoped,
        dataValid,
      ),
      instrumented: expectations
        ? {
          ts: expectations.processes.some((p) => p.agent === "ts" && p.activated),
          lua: expectations.processes.some((p) => p.agent === "lua" && p.activated),
        }
        : coverageInput.instrumented ?? { ts: null, lua: null },
      observed: {
        ts: scoped.some((event) => event.clock_domain === "monotonic_process"),
        lua: scoped.some((event) => event.clock_domain === "process_cpu"),
      },
      integrity: dataValid ? "valid" : "invalid",
    };
    if (!options.readOnly) {
      await Deno.writeTextFile(
        join(directory, "coverage.json"),
        JSON.stringify(coverage, null, 2) + "\n",
      );
    }
  }
  return {
    runId,
    ...(experimentId ? { experimentId } : {}),
    events,
    dataValid,
    quality,
    executors,
    ...(coverage ? { coverage } : {}),
  };
}
