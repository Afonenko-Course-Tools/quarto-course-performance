import { join } from "node:path";
import type { SourceManifest } from "../config/types.ts";
import type { NormalizedRun } from "./normalize.ts";
import { traces } from "../report/perfetto.ts";

export function operationTotals(run: NormalizedRun) {
  const begins = new Map(run.events.filter((e) => e.event === "begin").map((e) => [e.span_id, e]));
  const totals = new Map<
    string,
    {
      operation: string;
      clock: string;
      completed: number;
      errors: number;
      inclusive_us: number;
      self_us: null;
    }
  >();
  for (const end of run.events.filter((e) => e.event === "end")) {
    const begin = begins.get(end.span_id);
    if (!begin || end.timestamp_us! < begin.timestamp_us!) continue;
    const key = `${end.clock_domain}/${end.operation_id}`;
    const total = totals.get(key) ??
      {
        operation: end.operation_id!,
        clock: end.clock_domain,
        completed: 0,
        errors: 0,
        inclusive_us: 0,
        self_us: null,
      };
    total.completed++;
    total.errors += end.status === "error" ? 1 : 0;
    total.inclusive_us += end.timestamp_us! - begin.timestamp_us!;
    totals.set(key, total);
  }
  return [...totals.values()].sort((a, b) => b.inclusive_us - a.inclusive_us);
}
async function jsonFiles(directory: string, suffix: string) {
  const result: Record<string, unknown>[] = [];
  try {
    for await (const file of Deno.readDir(directory)) {
      if (file.isFile && file.name.endsWith(suffix)) {
        result.push(JSON.parse(await Deno.readTextFile(join(directory, file.name))));
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return result;
}
export async function writeExperimentReport(
  manifest: SourceManifest,
  runs: NormalizedRun[],
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
  const benchmarks = await jsonFiles(join(output, "benchmarks"), ".json");
  const summary = runs.map((run) => ({
    run_id: run.runId,
    data_valid: run.dataValid,
    events: run.events.length,
    quality: run.quality,
    operations: operationTotals(run),
    counters: Object.values(run.executors).map((e) => ({
      process_id: e.process_id,
      executor_id: e.executor_id,
      clock_domain: e.clock_domain,
      counters: e.counters,
      node_visits: null,
    })),
  }));
  const data = {
    manifest,
    summary,
    quality: runs.map((r) => ({ run_id: r.runId, ...r.quality })),
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
  for (const run of runs) {
    const path = join(output, "runs", run.runId);
    await Deno.mkdir(path, { recursive: true });
    const trace = traces(run);
    await Deno.writeTextFile(join(path, "wall.trace.json"), JSON.stringify(trace.wall));
    await Deno.writeTextFile(join(path, "lua-cpu.trace.json"), JSON.stringify(trace.luaCpu));
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
      return `| [${b.scenario}](benchmarks/${b.scenario}.json) | ${b.left} / ${b.right} | ${c.pairs} | ${
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
    ...runs.map((r) =>
      `| [${r.runId}](runs/${r.runId}/coverage.json) | ${
        r.dataValid ? "VALID" : "INVALID"
      } | ${r.quality.droppedEvents} | ${r.quality.incompleteSpans} | ${r.quality.errors.length} |`
    ),
    "",
    "[coverage.json](coverage.json) перечисляет выбранные модули, symbols, skipped конструкции и возможности runtime. complete относится к выбранному scope, а не ко всем функциям курса. Summary использует ручные semantic операции; trace дополнительно наблюдает выбранные функции и callbacks. Точные вызовы, walk_api_calls, filter_runs и handler_calls представлены раздельно в [summary.json](summary.json). Отсутствующее наблюдение не заменяется нулём.",
    "",
    "## Операции для дальнейшего исследования",
    "",
    ...runs.flatMap(
      (r) => [
        `### ${r.runId}`,
        "",
        ...(["monotonic_process", "process_cpu"] as const).flatMap((clock) => [
          `Шкала \`${clock}\`; первые 5 операций по inclusive времени:`,
          "",
          ...operationTotals(r).filter((o) => o.clock === clock).slice(0, 5).map((o) =>
            `- \`${o.operation}\`: ${o.completed} завершений, ${
              (o.inclusive_us / 1e6).toFixed(3)
            } с; ошибок ${o.errors}.`
          ),
          "",
        ]),
        `Raw: [events](runs/${r.runId}/events/), [wall trace](runs/${r.runId}/wall.trace.json), [Lua CPU trace](runs/${r.runId}/lua-cpu.trace.json).`,
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
}
