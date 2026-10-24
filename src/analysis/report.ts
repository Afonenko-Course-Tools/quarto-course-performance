import { basename, join, resolve } from "node:path";
import type { ReportSourceManifest } from "../config/types.ts";
import type { NormalizedRun } from "./normalize.ts";

import { jsonFiles, operationTotals, writeRunArtifacts } from "../report/run.ts";
import type { RunRecord } from "../report/types.ts";
export { operationTotals } from "../report/run.ts";

function summarizeRun(run: NormalizedRun) {
  return {
    run_id: run.runId,
    data_valid: run.dataValid,
    events: run.events.length,
    quality: run.quality,
    operations: operationTotals(run).map((o) => ({
      ...o,
      quality: run.dataValid ? "observed-exact" : "partial",
      completion_scope: "recorded-end-events",
    })),
    counters: Object.values(run.executors).map((e) => ({
      process_id: e.process_id,
      executor_id: e.executor_id,
      clock_domain: e.clock_domain,
      counters: e.counters,
      node_visits: null,
    })),
  };
}

export async function writeExperimentReport(
  manifest: ReportSourceManifest,
  runs: Iterable<NormalizedRun> | AsyncIterable<NormalizedRun>,
  output: string,
) {
  await Deno.mkdir(output, { recursive: true });
  const builds: Record<string, unknown>[] = [], coverage: Record<string, unknown>[] = [];
  try {
    for await (const item of Deno.readDir(join(output, "runs"))) {
      if (!item.isDirectory) continue;
      const dir = join(output, "runs", item.name);
      try {
        builds.push(JSON.parse(await Deno.readTextFile(join(dir, "run.json"))));
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
        builds.push({ runId: item.name, status: "INCOMPLETE" });
      }
      try {
        coverage.push({
          run_id: item.name,
          ...JSON.parse(await Deno.readTextFile(join(dir, "coverage.json"))),
        });
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const benchmarks = await jsonFiles(join(output, "benchmarks"), ".json", true);
  const summary: ReturnType<typeof summarizeRun>[] = [];
  for await (const run of runs) {
    summary.push(summarizeRun(run));
    const path = join(output, "runs", run.runId);
    await Deno.mkdir(path, { recursive: true });
    const build = builds.find((b) => b.runId === run.runId) ?? {};
    // Адаптер старого experiment metadata; raw journals и preparation receipts не меняются.
    let legacyQuarto = "quarto", legacyNativeArgv: string[] = [];
    if (build.schema_version !== 2 && build.argv !== undefined) {
      const argv = build.argv;
      if (
        !Array.isArray(argv) || argv.some((arg) => typeof arg !== "string") ||
        argv[1] !== "render" ||
        !(typeof argv[0] === "string" &&
          (["quarto", "quarto.exe"].includes(basename(argv[0]).toLowerCase()) ||
            argv[0] === manifest.runtime.quarto?.path))
      ) {
        throw new Error(
          "Legacy argv не описывает известный Quarto render; необходима явная адаптация команды",
        );
      }
      legacyQuarto = argv[0];
      legacyNativeArgv = argv.slice(2);
    }
    const record: RunRecord = build.schema_version === 2
      ? { ...build, dataValid: run.dataValid, quality: run.quality } as unknown as RunRecord
      : {
        ...build,
        schema_version: 2,
        runId: run.runId,
        request: {
          cwd: String(build.cwd ?? resolve(path)),
          quarto: legacyQuarto,
          nativeArgv: legacyNativeArgv,
          mode: (build.mode ?? "off") as RunRecord["request"]["mode"],
        },
        outcome: {
          code: Number(build.buildExitCode ?? 0),
          signal: (build.signal ?? null) as Deno.Signal | null,
          wallSeconds: Number(build.wallSeconds ?? 0),
          cpuUserSeconds:
            (build.resources as Record<string, number | null> | undefined)?.cpu_user_seconds ??
              null,
          cpuSystemSeconds:
            (build.resources as Record<string, number | null> | undefined)?.cpu_system_seconds ??
              null,
          peakRssKiB:
            (build.resources as Record<string, number | null> | undefined)?.peak_rss_kib ?? null,
        },
        preparation: (build.preparation ?? []) as RunRecord["preparation"],
        dataValid: run.dataValid,
        quality: run.quality,
        versions: {
          tool: "2.0.0",
          quarto: manifest.runtime.quarto?.version ?? "неизвестно",
          deno: manifest.runtime.deno?.version ?? null,
          pandoc: manifest.runtime.pandoc?.version ?? null,
        },
        git: null,
        collectionDirectory: String(build.outputDirectory ?? resolve(path)),
        outputDirectory: resolve(path),
        artifacts: {},
      };
    await writeRunArtifacts(path, record, run);
  }
  const data = {
    manifest,
    summary,
    quality: summary.map((r) => ({ run_id: r.run_id, ...r.quality })),
    coverage,
    builds,
    benchmarks,
  };
  for (const [name, contents] of Object.entries(data)) {
    await Deno.writeTextFile(
      join(output, name + ".json"),
      JSON.stringify(contents, null, 2) + "\n",
    );
  }
  const lines = [
    "# Отчёт Performance",
    "",
    `Эксперимент: \`${manifest.experimentId}\`.`,
    "",
    "TypeScript измеряет wall, Lua — CPU процесса. Шкалы раздельны. Inclusive интервалы вложены и могут перекрываться: их сумма не равна длительности сборки. Async self time и node_visits недоступны без отдельных наблюдений.",
    "",
    "## Сборки и сырой материал",
    "",
    "| Сценарий | Variant | Режим | Код сборки | Wall, с | Данные |",
    "| --- | --- | --- | ---: | ---: | --- |",
    ...builds.map((b) =>
      `| ${b.scenario ?? "?"} | ${b.variant ?? "?"} | ${b.mode ?? "?"} | ${
        b.buildExitCode ?? "INCOMPLETE"
      } | ${typeof b.wallSeconds === "number" ? b.wallSeconds.toFixed(3) : "—"} | [${
        b.dataValid ? "VALID" : "INVALID"
      }](runs/${b.runId}/run.json) |`
    ),
    "",
    "В diagnostic режимах wall показывает стоимость инструментированного запуска. Накладные расходы off оцениваются отдельными парными сериями ниже. Код сборки и качество телеметрии независимы.",
    "",
    "## Парные off измерения",
    "",
    "| Сценарий | Контроль / candidate | Пар | Median ratio | 95% CI | Статус |",
    "| --- | --- | ---: | ---: | --- | --- |",
    ...benchmarks.filter((b) => b.complete === true).map((b) => {
      const c = b.comparison as {
        pairs: number;
        medianRatio: number;
        interval95: number[];
        status: string;
      };
      return `| [${b.scenario}](benchmarks/${b.file_name}) | ${b.left} / ${b.right} | ${c.pairs} | ${
        c.medianRatio.toFixed(5)
      } | ${c.interval95.map((n) => n.toFixed(5)).join("–")} | ${c.status} |`;
    }),
    "",
    "Порог: верхняя граница ≤1.01 — PASS; нижняя >1.01 — FAIL; пересечение — INCONCLUSIVE. Bootstrap median парных ratios: 10 000 resamples, seed хранится в raw series. Прогревы исключены. Незавершённая серия не даёт acceptance.",
    "",
    "## Качество и покрытие",
    "",
    "| Запуск | Данные | Потери | Незавершённые | Ошибки |",
    "| --- | --- | ---: | ---: | ---: |",
    ...summary.map((r) =>
      `| [${r.run_id}](runs/${r.run_id}/coverage.json) | ${
        r.data_valid ? "VALID" : "INVALID"
      } | ${r.quality.droppedEvents} | ${r.quality.incompleteSpans} | ${r.quality.errors.length} |`
    ),
    "",
    "[coverage.json](coverage.json) перечисляет выбранные модули, symbols, skipped конструкции и возможности runtime. complete относится к выбранному scope, а не ко всем функциям курса. Summary использует ручные semantic операции; trace дополнительно наблюдает выбранные функции и callbacks. Точные вызовы, walk_api_calls, filter_runs и handler_calls представлены раздельно в [summary.json](summary.json). Отсутствующее наблюдение не заменяется нулём.",
    "",
    "## Операции для дальнейшего исследования",
    "",
    ...summary.flatMap(
      (r) => [
        `### ${r.run_id}`,
        "",
        ...(["monotonic_process", "process_cpu"] as const).flatMap((clock) => [
          `Шкала \`${clock}\`; первые 5 операций по inclusive времени:`,
          "",
          ...r.operations.filter((o) => o.clock === clock).slice(0, 5).map((o) =>
            `- \`${o.operation}\`: ${o.completed} завершений, ${
              (o.inclusive_us / 1e6).toFixed(3)
            } с; ошибок ${o.errors}.`
          ),
          "",
        ]),
        `Raw: [events](runs/${r.run_id}/events/), [wall trace](runs/${r.run_id}/wall.trace.json), [Lua CPU trace](runs/${r.run_id}/lua-cpu.trace.json), [causal graph](runs/${r.run_id}/causal.json).`,
        "",
      ],
    ),
    "Рейтинг — кандидаты для исследования, а не доказательство причинности. Повторные операции сопоставляйте с synthetic scaling и отдельным обычным benchmark.",
    "",
    "## Источники",
    "",
    ...manifest.sources.map((s) => `- ${s.repository}: \`${s.remoteRef}\`, \`${s.sha}\`.`),
    "",
    "Хеши runtime и receipts всех установленных копий: [manifest.json](manifest.json), manifests отдельных runs. Raw Hyperfine JSON, stdout/stderr, argv/cwd/cache policy сохранены рядом с run.json.",
    "",
    "Lua sampling backend: unavailable. Lua CPU начинается локально в каждом executor; на wall шкалу не переносится. CPU samples Deno не являются точными счётчиками вызовов. TS symbol mapping указывает исходные диапазоны; универсальное восстановление transpiled строк CPU profile не гарантируется. Lua функции на одинаковых строках различаются runtime identity и ordinal первого наблюдения; ordinal между runs не обещает стабильность.",
  ];
  await Deno.writeTextFile(join(output, "report.md"), lines.join("\n") + "\n");
  return { dataValid: summary.every((r) => r.data_valid), diagnostics: summary.length };
}
