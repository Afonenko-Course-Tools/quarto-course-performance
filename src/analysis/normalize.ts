import { join } from "node:path";
import { files } from "../sources/snapshot.ts";
import type { Event } from "../protocol/types.ts";
import { validateEvent } from "../protocol/validate.ts";
import { type DiagnosticExpectations, validateDiagnosticExpectations } from "../report/types.ts";
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
    const [begin, end] = rows;
    if (begin.event !== "begin" || end.event !== "end" || end.status === "aborted") continue;
    if (
      ["experiment_id", "run_id", "process_id", "executor_id", "operation_id", "clock_domain"].some(
        (key) => begin[key as keyof Event] !== end[key as keyof Event],
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
export async function normalizeRun(directory: string): Promise<NormalizedRun> {
  const events: Event[] = [],
    quality: QualitySummary = {
      droppedEvents: 0,
      incompleteSpans: 0,
      coverageComplete: false,
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
  let expectations: DiagnosticExpectations | undefined;
  try {
    expectations = validateDiagnosticExpectations(
      JSON.parse(await Deno.readTextFile(join(directory, "expectations.json"))),
    );
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) quality.errors.push(`Expectations: ${String(e)}`);
  }
  const processes: Record<string, unknown>[] = [];
  try {
    for await (const entry of Deno.readDir(join(directory, "processes"))) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const process = JSON.parse(await Deno.readTextFile(join(directory, "processes", entry.name)));
      processes.push(process);
      if (process.expectation) {
        const receipt = validateDiagnosticExpectations({
          schema_version: 2,
          processes: [process.expectation],
        });
        expectations ??= { schema_version: 2, processes: [] };
        const old = expectations.processes.findIndex((p) =>
          p.process_id === process.expectation.process_id && p.agent === process.expectation.agent
        );
        if (old >= 0) expectations.processes[old] = receipt.processes[0];
        else expectations.processes.push(receipt.processes[0]);
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) quality.errors.push(`Processes: ${String(e)}`);
  }
  let entries: string[] = [];
  try {
    entries = await files(join(directory, "events"));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound) || !expectations) {
      quality.errors.push(`Журналы отсутствуют: ${String(e)}`);
    }
  }
  let summaries = 0;
  const summaryPaths = new Map<string, Record<string, unknown>>();
  const started: { path: string; process_id: string; executor_id: string; agent: "ts" | "lua" }[] =
    [];
  for (const path of entries) {
    if (path.endsWith(".started.json")) {
      try {
        const receipt = JSON.parse(await Deno.readTextFile(path));
        if (
          receipt.schema_version !== 1 || typeof receipt.process_id !== "string" ||
          !receipt.process_id || typeof receipt.executor_id !== "string" || !receipt.executor_id ||
          !["ts", "lua"].includes(receipt.agent) || receipt.executed !== true
        ) throw new Error("Некорректный executor started receipt");
        started.push({ ...receipt, path });
      } catch (e) {
        quality.errors.push(`Started ${path}: ${String(e)}`);
      }
    } else if (path.endsWith(".summary.json")) {
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
        summaryPaths.set(path, s);
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
          events.push(e);
          if (runId && e.run_id !== runId) throw new Error("Смешаны run_id");
          if (experimentId && e.experiment_id !== experimentId) {
            throw new Error("Смешаны experiment_id");
          }
          runId = e.run_id;
          experimentId = e.experiment_id;
        } catch (e) {
          quality.errors.push(`Event ${path}: ${String(e)}`);
        }
      }
    }
  }
  if (started.length) expectations ??= { schema_version: 2, processes: [] };
  if (!summaries && !expectations) quality.errors.push("Нет итогов executors");
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
  quality.incompleteSpans = Math.max(
    open.size + events.filter((e) => e.event === "end" && e.status === "aborted").length,
    quality.incompleteSpans,
  );
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
      quality.errors.push(`Неподтверждённый parent ${e.parent_span_id}`);
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
  if (expectations) {
    for (const receipt of started) {
      let expected = expectations.processes.find((p) =>
        p.process_id === receipt.process_id && p.agent === receipt.agent
      );
      if (!expected) {
        expected = {
          process_id: receipt.process_id,
          agent: receipt.agent,
          requested: true,
          supported: true,
          activated: true,
          executed: true,
        };
        expectations.processes.push(expected);
      }
      if (!expected.requested || !expected.supported) {
        quality.errors.push(
          `Started противоречит ожиданиям: ${receipt.process_id}/${receipt.agent}`,
        );
      } else {
        expected.activated = true;
        expected.executed = true;
        expected.summary_path ??= receipt.agent === "ts"
          ? `events/${receipt.process_id}/${receipt.executor_id}.summary.json`
          : `events/${receipt.process_id}/`;
      }
    }
    try {
      validateDiagnosticExpectations(expectations);
    } catch (e) {
      quality.errors.push(`Expectations: ${String(e)}`);
    }
    for (const expected of expectations.processes) {
      if (expected.summary_path) {
        const path = join(directory, expected.summary_path);
        const matches = [...summaryPaths].some(([file, summary]) =>
          (expected.summary_path!.endsWith("/")
            ? file.startsWith(path.endsWith("/") ? path : path + "/")
            : file === path) &&
          summary.process_id === expected.process_id &&
          summary.clock_domain === (expected.agent === "ts" ? "monotonic_process" : "process_cpu")
        );
        if (!matches) {
          quality.errors.push(
            `Отсутствует ожидаемый summary: ${expected.process_id} ${expected.summary_path}`,
          );
        }
      }
      if (expected.profile_path) {
        try {
          const profile = JSON.parse(
            await Deno.readTextFile(join(directory, expected.profile_path)),
          );
          if (
            !Array.isArray(profile.nodes) || !Number.isFinite(profile.startTime) ||
            !Number.isFinite(profile.endTime) || profile.endTime < profile.startTime
          ) throw new Error("Некорректный CPU profile");
        } catch (e) {
          quality.errors.push(`CPU ${expected.process_id}: ${String(e)}`);
        }
      }
    }
    for (const receipt of started) {
      const summary = summaryPaths.get(receipt.path.replace(/\.started\.json$/, ".summary.json"));
      if (
        !summary || summary.process_id !== receipt.process_id ||
        summary.executor_id !== receipt.executor_id ||
        summary.clock_domain !== (receipt.agent === "ts" ? "monotonic_process" : "process_cpu")
      ) {
        quality.errors.push(
          `Отсутствует summary начавшегося executor: ${receipt.process_id}/${receipt.executor_id}`,
        );
      }
    }
    await Deno.writeTextFile(
      join(directory, "expectations.json"),
      JSON.stringify(expectations, null, 2) + "\n",
    );
  }
  for (const process of processes) {
    if (process.expectation && process.exit_code === null) {
      quality.errors.push(`Нет подтверждённого завершения процесса: ${process.process_id}`);
    }
    if (process.signal) {
      quality.errors.push(`Процесс прерван: ${process.process_id} ${process.signal}`);
    }
    // Только исторический импорт без v2 receipt использует прежнюю эвристику argv.
    if (expectations) continue;
    const argv = Array.isArray(process.argv) ? process.argv as string[] : [];
    if (
      process.kind === "pandoc" && argv.some((a) =>
        a === "--lua-filter" || a.startsWith("--lua-filter=")
      ) &&
      !Object.values(executors).some((e) =>
        e.process_id === process.process_id && e.clock_domain === "process_cpu"
      )
    ) quality.errors.push(`Отсутствует Lua child summary: ${process.process_id}`);
    if (
      process.kind === "deno" && argv[0] === "run" && !executors[`${process.process_id}/ts`]
    ) quality.errors.push(`Отсутствует child summary: ${process.process_id}`);
  }
  const dataValid = !quality.droppedEvents && !quality.incompleteSpans && !quality.errors.length;
  quality.coverageComplete &&= dataValid;
  if (expectations) {
    try {
      const path = join(directory, "coverage.json"),
        coverage = JSON.parse(await Deno.readTextFile(path));
      const instrumented = {
        ts: expectations.processes.some((p) => p.agent === "ts" && p.activated),
        lua: expectations.processes.some((p) => p.agent === "lua" && p.activated),
      };
      const observed = {
        ts: events.some((e) => e.clock_domain === "monotonic_process"),
        lua: events.some((e) => e.clock_domain === "process_cpu"),
      };
      await Deno.writeTextFile(
        path,
        JSON.stringify(
          {
            ...coverage,
            complete: quality.coverageComplete,
            instrumented,
            observed,
            integrity: dataValid ? "valid" : "invalid",
          },
          null,
          2,
        ) + "\n",
      );
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  return {
    runId,
    ...(experimentId ? { experimentId } : {}),
    events,
    dataValid,
    quality,
    executors,
  };
}
