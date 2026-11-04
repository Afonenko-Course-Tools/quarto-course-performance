import { isAbsolute, join } from "node:path";
import {
  type CounterAggregate,
  PublicationError,
  type PublishedRun,
  type RunRecord,
  type RunSummary,
} from "./types.ts";
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
  const exact = record.completion.kind === "complete" && record.dataValid
    ? "observed-exact" as const
    : "partial" as const;
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
    completion: record.completion.kind,
    normalization: normalized ? "available" : "not-processed",
    ...(record.importProvenance ? { importProvenance: record.importProvenance } : {}),
    dataValid: record.completion.kind === "complete" && record.dataValid,
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
/** Представление уже прочитанных receipts; аргументы команд в отчёт не попадают. */
export function nativeCommandMarkdown(processes: readonly Record<string, unknown>[]): string[] {
  const displayedId = (value: unknown) =>
    typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value
      : "не показан";
  const runFlags = new Set([
    "--unstable-ffi",
    "--unstable-kv",
    "--no-config",
    "--no-lock",
    "--cached-only",
    "--allow-all",
    "-A",
    "--no-check",
  ]);
  const rows = processes.map((process) => {
    const timing = process.native_command;
    const seconds = timing && typeof timing === "object" && "wall_seconds" in timing &&
        "clock_domain" in timing && timing.clock_domain === "monotonic_process" &&
        "scope" in timing && timing.scope === "launcher-spawn-to-status" &&
        typeof timing.wall_seconds === "number" && Number.isFinite(timing.wall_seconds) &&
        timing.wall_seconds >= 0
      ? timing.wall_seconds
      : null;
    let category = process.kind === "pandoc" ? "Pandoc" : "Deno";
    if (process.kind === "deno" && Array.isArray(process.argv)) {
      const argv: readonly unknown[] = process.argv;
      let entry = 0;
      if (argv[0] === "run") {
        entry = 1;
        while (true) {
          const flag = argv[entry];
          if (typeof flag !== "string" || !(runFlags.has(flag) || flag.startsWith("--v8-flags="))) {
            break;
          }
          entry++;
        }
        if (argv[entry] === "--") entry++;
      }
      const script = argv[entry], verb = argv[entry + 1];
      if (
        typeof script === "string" && /(?:^|[/\\])quarto\.js$/.test(script) &&
        (verb === "render" || verb === "inspect" || verb === "pandoc" || verb === "run")
      ) {
        category = `Quarto ${verb}`;
      }
    }
    const exit = typeof process.exit_code === "number" && Number.isInteger(process.exit_code)
      ? String(process.exit_code)
      : "неизвестно";
    const signal = typeof process.signal === "string" && /^SIG[A-Z0-9]+$/.test(process.signal)
      ? process.signal
      : process.signal === null
      ? "—"
      : "неизвестно";
    return {
      seconds,
      line: `| ${category} | ${
        seconds === null ? "неизвестно" : seconds.toFixed(3)
      } | ${exit} | ${signal} | ${displayedId(process.process_id)} | ${
        process.parent_link === "confirmed"
          ? displayedId(process.parent_process_id)
          : "не подтверждён"
      } |`,
    };
  });
  if (!rows.length) return [];
  rows.sort((a, b) => (b.seconds ?? -1) - (a.seconds ?? -1));
  return [
    "## Наблюдаемые интервалы команд",
    "",
    "Wall от запуска launcher до получения статуса; это inclusive интервалы, их нельзя складывать. Это не self time, CPU, критический путь или полный список процессов ОС. Покрытие частичное; отсутствие времени означает неизвестное значение, а не ноль.",
    "",
    "| Категория | Wall, с | Exit | Сигнал | Процесс | Подтверждённый родитель |",
    "| --- | ---: | --- | --- | --- | --- |",
    ...rows.map((row) => row.line),
    "",
  ];
}
export async function writeRunArtifacts(
  directory: string,
  record: RunRecord,
  normalized?: NormalizedRun,
  previous?: PublishedRun,
): Promise<PublishedRun> {
  const publication = { record, directory };
  try {
    await Deno.mkdir(directory, { recursive: true });
    const temporary = join(directory, `run.${crypto.randomUUID()}.tmp`);
    await Deno.writeTextFile(temporary, JSON.stringify(record, null, 2) + "\n");
    await Deno.rename(temporary, join(directory, "run.json"));
  } catch (cause) {
    throw new PublicationError(record.runId, directory, "record", cause, previous, record);
  }
  try {
    if (record.completion.kind === "complete" && normalized?.coverage) {
      await Deno.writeTextFile(
        join(directory, "coverage.json"),
        JSON.stringify(normalized.coverage, null, 2) + "\n",
      );
    }
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
    if (record.completion.kind === "complete") {
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
    }
    const views: { path: string; clock: string; process_id?: string; executor_id?: string }[] = [];
    const profiles: { path: string; process_id: string }[] = [];
    let commandLines: string[] = [];
    if (record.completion.kind === "complete" && normalized && record.request.mode !== "off") {
      const processes = await jsonFiles(join(directory, "processes"), ".json");
      commandLines = nativeCommandMarkdown(processes);
      const trace = traces(normalized, processes);
      await Deno.writeTextFile(join(directory, "wall.trace.json"), JSON.stringify(trace.wall));
      await Deno.writeTextFile(join(directory, "lua-cpu.trace.json"), JSON.stringify(trace.luaCpu));
      views.push({ path: "wall.trace.json", clock: "calibrated-wall" }, {
        path: "lua-cpu.trace.json",
        clock: "local-lua-cpu",
      });
      for (const local of trace.localWall) {
        await Deno.writeTextFile(join(directory, local.fileName), JSON.stringify(local.trace));
        const source = local.trace.traceEvents.find((e) => e.ph === "X")!;
        views.push({
          path: local.fileName,
          clock: "local-wall",
          process_id: String(source.args.process_id),
          executor_id: String(source.args.executor_id),
        });
        artifacts[`localWall${trace.localWall.indexOf(local) + 1}`] = local.fileName;
      }
      await Deno.writeTextFile(
        join(directory, "export.json"),
        JSON.stringify(
          {
            schema_version: 1,
            format: "chrome-trace-event-json",
            run_id: record.runId,
            data_valid: record.dataValid,
            coverage_complete: record.quality.coverageComplete,
            quality: record.quality,
            files: views,
            executors: Object.entries(normalized.executors).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0
            ).map(([key, e]) => ({
              process_id: e.process_id ?? key.split("/")[0],
              executor_id: e.executor_id ?? key.split("/").slice(1).join("/"),
              clock_domain: e.clock_domain ?? null,
            })),
          },
          null,
          2,
        ) + "\n",
      );
      artifacts.export = "export.json";
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
    if (record.completion.kind === "complete" && record.request.mode !== "off") {
      try {
        for await (const entry of Deno.readDir(join(directory, "profiles"))) {
          if (!entry.isDirectory) continue;
          const path = `profiles/${entry.name}/cpu.cpuprofile`;
          try {
            if ((await Deno.lstat(join(directory, path))).isFile) {
              profiles.push({ path, process_id: entry.name });
            }
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    profiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const summary = summarizeRunRecord(
      record,
      record.completion.kind === "complete" ? normalized : undefined,
    );
    for (const [name, value] of Object.entries({ summary })) {
      await Deno.writeTextFile(
        join(directory, name + ".json"),
        JSON.stringify(value, null, 2) + "\n",
      );
    }
    const outcome = record.completion.native;
    const lines = [
      "# Отчёт Performance",
      "",
      `Запуск: \`${record.runId}\`. Режим: \`${record.request.mode}\`. Код Native: ${
        outcome?.code ?? "UNKNOWN"
      }. Сигнал: ${outcome ? outcome.signal ?? "—" : "UNKNOWN"}.`,
      "",
      `Completion: ${record.completion.kind.toUpperCase()}. Наблюдённый wall driver: ${
        record.observedWallSeconds.toFixed(3)
      } с.`,
      `Capture mode: ${
        record.stdioMode ?? "UNKNOWN"
      }; log channels: stdout=${record.streams.stdout}, stderr=${record.streams.stderr}.`,
      ...(record.completion.kind === "incomplete"
        ? [
          `Причина: ${record.completion.reason}; requested signal: ${
            record.completion.requestedSignal ?? "—"
          }.`,
        ]
        : []),
      `Wall Native: ${outcome ? outcome.wallSeconds.toFixed(3) : "UNKNOWN"} с. CPU user: ${
        outcome?.cpuUserSeconds ?? "недоступно"
      }; CPU system: ${outcome?.cpuSystemSeconds ?? "недоступно"}; peak RSS, KiB: ${
        outcome?.peakRssKiB ?? "недоступно"
      }.`,
      "",
      record.request.mode === "off"
        ? "Диагностические наблюдения в режиме off не собираются."
        : "TypeScript измеряет wall, Lua — CPU процесса. Шкалы раздельны; inclusive интервалы могут перекрываться.",
      "",
      `Качество данных: ${
        record.completion.kind === "complete" && record.dataValid ? "VALID" : "INVALID"
      }. Resource scope: ${outcome?.resourceScope ?? "unavailable"}; wall scope: ${
        outcome?.wallScope ?? "UNKNOWN"
      }.`,
      "",
      ...commandLines,
      ...(record.stdioMode === "pty-combined"
        ? [
          "stdout.log содержит общий терминальный поток Native stdout/stderr; stderr.log — отдельный supervisor channel. Их EOF описывают эти log channels, а не два независимых Native streams.",
          "",
        ]
        : []),
      ...Object.entries(artifacts).filter(([name]) => name !== "report").map(([name, path]) =>
        `- [${name}](${encodeURI(path).replaceAll("(", "%28").replaceAll(")", "%29")})`
      ),
      "",
      ...(views.length
        ? [
          "## Просмотр измерений",
          "",
          "Perfetto: откройте локальный trace-файл через Open trace file. Общая wall-шкала содержит только калиброванные часы; локальная wall-шкала каждого некалиброванного исполнителя и Lua CPU читаются отдельно.",
          "",
          "Логические дорожки не являются потоками ОС. Стрелки показывают записанное родительство по началам spans; задержка передачи управления не измеряется. Inclusive интервалы могут перекрываться. Счётчики остаются в summary.json. Пиковая память: run.json: completion.native.peakRssKiB.",
          "",
          ...views.map((v) =>
            `- [${
              v.clock === "calibrated-wall"
                ? "общая wall-шкала"
                : v.clock === "local-wall"
                ? "локальная wall-шкала"
                : "Lua CPU"
            }](${v.path})`
          ),
          "",
        ]
        : []),
      ...(profiles.length
        ? [
          "Speedscope: откройте существующий файл .cpuprofile. Профиль содержит CPU samples, а не точные счётчики вызовов. Качество данных указано выше; профиль не подтверждает полное покрытие.",
          "",
          ...profiles.map((p) =>
            `- [CPU-профиль процесса ${
              p.process_id.replaceAll("[", "\\[").replaceAll("]", "\\]")
            }](${encodeURI(p.path).replaceAll("(", "%28").replaceAll(")", "%29")})`
          ),
          "",
        ]
        : []),
    ];
    await Deno.writeTextFile(join(directory, "report.md"), lines.join("\n"));
    return publication;
  } catch (cause) {
    throw new PublicationError(record.runId, directory, "derived", cause, publication, record);
  }
}
