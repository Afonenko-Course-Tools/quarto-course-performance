import { isAbsolute, join } from "node:path";
import type { CounterAggregate, RunRecord, RunSummary } from "./types.ts";
import {
  type NormalizedRun,
  operationAttribution,
  validatedEvents,
  validatedIntervals,
} from "../analysis/normalize.ts";
import { traces } from "./perfetto.ts";
export function operationTotals(run: NormalizedRun) {
  const totals = new Map<
    string,
    {
      operation: string;
      clock: string;
      completed: number;
      errors: number;
      inclusive_us: number;
      self_us: null;
      extension_id: string | null;
      extension_attribution: "recorded" | "derived" | "unavailable";
    }
  >();
  for (const { begin, end, durationUs } of validatedIntervals(run)) {
    const attribution = operationAttribution(begin);
    const key =
      `${end.clock_domain}/${end.operation_id}/${attribution.extension_id}/${attribution.extension_attribution}`;
    const total = totals.get(key) ??
      {
        operation: end.operation_id!,
        clock: end.clock_domain,
        completed: 0,
        errors: 0,
        inclusive_us: 0,
        self_us: null,
        ...attribution,
      };
    total.completed++;
    total.errors += end.status === "error" ? 1 : 0;
    total.inclusive_us += durationUs;
    totals.set(key, total);
  }
  return [...totals.values()].sort((a, b) => b.inclusive_us - a.inclusive_us);
}
export async function jsonFiles(directory: string, suffix: string, retainFileName = false) {
  const result: Record<string, unknown>[] = [];
  try {
    for await (const file of Deno.readDir(directory)) {
      if (file.isFile && file.name.endsWith(suffix)) {
        const record = JSON.parse(await Deno.readTextFile(join(directory, file.name)));
        result.push(retainFileName ? { ...record, file_name: file.name } : record);
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return result;
}

export function summarizeRunRecord(record: RunRecord, normalized?: NormalizedRun): RunSummary {
  const exact = record.dataValid ? "observed-exact" as const : "partial" as const;
  const deltas = new Map<string, CounterAggregate>();
  for (const event of normalized ? validatedEvents(normalized) : []) {
    if (event.event !== "counter" || !event.counter) continue;
    const key = `${event.process_id}/${event.executor_id}/${event.counter.name}`;
    const aggregate = deltas.get(key) ??
      {
        processId: event.process_id,
        executorId: event.executor_id,
        name: event.counter.name,
        value: 0,
        source: "event",
        semantics: "delta",
        quality: exact,
      };
    aggregate.value += event.counter.value;
    if (event.counter.quality === "partial") aggregate.quality = "partial";
    deltas.set(key, aggregate);
  }
  return {
    schema_version: 2,
    runId: record.runId,
    ...(record.importProvenance ? { importProvenance: record.importProvenance } : {}),
    dataValid: record.dataValid,
    quality: record.quality,
    operations: normalized
      ? operationTotals(normalized).map((o) => ({
        operationId: o.operation,
        extensionId: o.extension_id,
        extensionAttribution: o.extension_attribution,
        clockDomain: o.clock as "monotonic_process" | "process_cpu",
        completed: o.completed,
        errors: o.errors,
        inclusiveMicroseconds: o.inclusive_us,
        selfMicroseconds: null,
        quality: exact,
      }))
      : [],
    counters: [
      ...deltas.values(),
      ...(normalized
        ? Object.values(normalized.executors).flatMap((e) =>
          Object.entries((e.counters ?? {}) as Record<string, number>).map(([name, value]) => ({
            processId: String(e.process_id),
            executorId: String(e.executor_id),
            name,
            value,
            source: "executor-summary" as const,
            semantics: "total" as const,
            quality: exact,
          }))
        )
        : []),
    ],
  };
}
export async function writeRunArtifacts(
  directory: string,
  record: RunRecord,
  normalized?: NormalizedRun,
): Promise<void> {
  await Deno.mkdir(directory, { recursive: true });
  const artifacts: Record<string, string> = {
    run: "run.json",
    summary: "summary.json",
    report: "report.md",
  };
  // Только относительные ссылки, существующие в этом запуске. Collection — provenance.
  for (const [name, path] of Object.entries(record.artifacts)) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
      throw new Error(`Недопустимый artifact path: ${path}`);
    }
    if (!["run.json", "summary.json", "report.md"].includes(path)) {
      await Deno.lstat(join(directory, path));
    }
    artifacts[name] = path;
  }
  for (
    const [name, path] of Object.entries({
      stdout: "stdout.log",
      stderr: "stderr.log",
      events: "events",
      profiles: "profiles",
      processes: "processes",
      coverage: "coverage.json",
      manifest: "manifest.json",
    })
  ) {
    try {
      await Deno.lstat(join(directory, path));
      artifacts[name] = path;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  if (normalized) {
    const trace = traces(normalized);
    await Deno.writeTextFile(join(directory, "wall.trace.json"), JSON.stringify(trace.wall));
    await Deno.writeTextFile(join(directory, "lua-cpu.trace.json"), JSON.stringify(trace.luaCpu));
    const processes = await jsonFiles(join(directory, "processes"), ".json");
    await Deno.writeTextFile(
      join(directory, "causal.json"),
      JSON.stringify(
        {
          run_id: record.runId,
          data_valid: record.dataValid,
          processes,
          spans: validatedEvents(normalized).filter((e) => e.event === "begin").map((e) => ({
            span_id: e.span_id,
            parent_span_id: e.parent_span_id ?? null,
            process_id: e.process_id,
            executor_id: e.executor_id,
            operation_id: e.operation_id,
            clock_domain: e.clock_domain,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    Object.assign(artifacts, {
      wall: "wall.trace.json",
      luaCpu: "lua-cpu.trace.json",
      causal: "causal.json",
    });
  }
  const metadata = { ...record, artifacts };
  const summary = summarizeRunRecord(metadata, normalized);
  for (const [name, value] of Object.entries({ run: metadata, summary })) {
    await Deno.writeTextFile(
      join(directory, name + ".json"),
      JSON.stringify(value, null, 2) + "\n",
    );
  }
  const lines = [
    "# Отчёт Performance",
    "",
    `Запуск: \`${record.runId}\`. Режим: \`${record.request.mode}\`. Код Quarto: ${record.outcome.code}. Сигнал: ${
      record.outcome.signal ?? "—"
    }.`,
    "",
    `Wall: ${record.outcome.wallSeconds.toFixed(3)} с. CPU user: ${
      record.outcome.cpuUserSeconds ?? "недоступно"
    }; CPU system: ${record.outcome.cpuSystemSeconds ?? "недоступно"}; peak RSS, KiB: ${
      record.outcome.peakRssKiB ?? "недоступно"
    }.`,
    "",
    record.request.mode === "off"
      ? "Диагностические наблюдения в режиме off не собираются."
      : "TypeScript измеряет wall, Lua — CPU процесса. Шкалы раздельны; inclusive интервалы могут перекрываться.",
    "",
    `Качество данных: ${record.dataValid ? "VALID" : "INVALID"}.`,
    "",
    ...(record.outcome.stdioMode === "pty-combined"
      ? [
        "stdout.log содержит общий терминальный поток stdout/stderr; пустой stderr.log не означает отсутствия ошибок.",
        "",
      ]
      : []),
    ...Object.entries(artifacts).filter(([name]) => name !== "report").map(([name, path]) =>
      `- [${name}](${path})`
    ),
    "",
  ];
  await Deno.writeTextFile(join(directory, "report.md"), lines.join("\n"));
}
