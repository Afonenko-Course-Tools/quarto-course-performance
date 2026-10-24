import { join } from "node:path";
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

/** Refuse in-place historical imports before normalization or any output write. */
export async function assertWritableExperiment(
  manifest: ReportSourceManifest,
  output: string,
): Promise<void> {
  const historical = () =>
    new Error("Исторические metadata доступны read-only; in-place report/verify не поддерживается");
  if (manifest.schema_version !== 2) throw historical();
  try {
    const aggregate = JSON.parse(await Deno.readTextFile(join(output, "summary.json")));
    if (!aggregate || aggregate.schema_version !== 2 || !Array.isArray(aggregate.runs)) {
      throw historical();
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  try {
    for await (const item of Deno.readDir(join(output, "runs"))) {
      if (!item.isDirectory) continue;
      try {
        const metadata = JSON.parse(
          await Deno.readTextFile(join(output, "runs", item.name, "run.json")),
        );
        if (!metadata || metadata.schema_version !== 2) throw historical();
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export async function writeExperimentReport(
  manifest: ReportSourceManifest,
  runs: Iterable<NormalizedRun> | AsyncIterable<NormalizedRun>,
  output: string,
) {
  await assertWritableExperiment(manifest, output);
  const builds: Record<string, unknown>[] = [], coverage: Record<string, unknown>[] = [];
  try {
    for await (const item of Deno.readDir(join(output, "runs"))) {
      if (!item.isDirectory) continue;
      const dir = join(output, "runs", item.name);
      try {
        const metadata = JSON.parse(await Deno.readTextFile(join(dir, "run.json")));
        if (!metadata || metadata.schema_version !== 2) {
          throw new Error(
            "Исторические metadata доступны read-only; in-place report/verify не поддерживается",
          );
        }
        builds.push(metadata);
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
  await Deno.mkdir(output, { recursive: true });
  const benchmarks = await jsonFiles(join(output, "benchmarks"), ".json", true);
  const summary: ReturnType<typeof summarizeRun>[] = [];
  for await (const run of runs) {
    summary.push(summarizeRun(run));
    const path = join(output, "runs", run.runId);
    await Deno.mkdir(path, { recursive: true });
    const build = builds.find((b) => b.runId === run.runId);
    if (!build || build.schema_version !== 2) {
      throw new Error(`Отсутствуют текущие metadata запуска: ${run.runId}`);
    }
    const record = {
      ...build,
      dataValid: run.dataValid,
      quality: run.quality,
    } as unknown as RunRecord;
    await writeRunArtifacts(path, record, run);
  }
  const data = {
    manifest,
    summary: { schema_version: 2, experimentId: manifest.experimentId, runs: summary },
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
    "| Сценарий | Контроль / candidate | Пар | Порог ratio | Median ratio | 95% CI | Статус |",
    "| --- | --- | ---: | ---: | ---: | --- | --- |",
    ...benchmarks.filter((b) => b.complete === true).map((b) => {
      const c = b.comparison as {
        pairs: number;
        maxSlowdownRatio?: number;
        medianRatio: number;
        interval95: number[];
        status: string;
      };
      return `| [${b.scenario}](benchmarks/${b.file_name}) | ${b.left} / ${b.right} | ${c.pairs} | ${
        c.maxSlowdownRatio?.toFixed(5) ?? "не сохранён"
      } | ${c.medianRatio.toFixed(5)} | ${
        c.interval95.map((n) => n.toFixed(5)).join("–")
      } | ${c.status} |`;
    }),
    "",
    "Верхняя граница ≤ порога серии — PASS; нижняя > порога серии — FAIL; пересечение — INCONCLUSIVE. Порог берётся из сохранённой политики соответствующей серии. Bootstrap median парных ratios: 10 000 resamples, seed хранится в raw series. Прогревы исключены. Незавершённая серия не даёт acceptance.",
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
