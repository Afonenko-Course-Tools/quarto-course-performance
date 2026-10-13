# Performance для Quarto-курсов

Отдельный runner для воспроизводимых измерений Java и расширений курса. Постоянные TS/Lua фасады в пакетах регистрируют значимые операции; агенты, Compiler API, launchers и runtime patches находятся в этом проекте и подготавливаются только для диагностики.

| Режим | Наблюдение | Назначение |
| --- | --- | --- |
| `off` | Внешние wall/CPU/RSS; фасады возвращают исходные функции | Обычные сборки и парные benchmark |
| `summary` | Ручные semantic операции, точные вызовы и объявленные walk scopes | Поиск повторной работы |
| `cpu` | Summary и отдельный V8 CPU profile каждого Deno run | Исследование затрат TS |
| `trace` | Summary, выбранные TS функции и Lua call/return/callback hooks | Подробное исследование выбранного scope |

В `off` нет агентов, clock reads в фасадах, hooks, per-node wrappers или файлов телеметрии. Если вызывающий Deno не разрешает чтение env, фасад также возвращает identity. Наличие небольших импортов и регистрации проверяется внешним benchmark; нулевые накладные расходы не предполагаются.

## Запуск

Пилот проверяется с Quarto 1.11.5, его Deno 2.7.14 и Pandoc 3.10/Lua 5.4, Hyperfine 2.0.0, Git, CUE и unzip. Runner требует `deno run -A`; установленным расширениям такие дополнительные разрешения не требуются. TypeScript 5.9.3 и luaparse 0.3.1 закреплены в `deno.lock` и используются только инструментами этого проекта. Browser проверки владельцев используют их собственные lock files.

Команды выполняются из корня проекта. В примерах `deno` — проверенная версия runner. `--workspace` содержит временные копии, raw журналы и отчёт; каталог исключён из Git.

```sh
deno task check
deno task test
deno task perf capabilities
deno task perf sources --workspace .workspace/baseline
```

`sources` получает GitHub refs и сохраняет immutable SHA. Java в пилоте начинается с согласованной ветки `codex/labs-1-3-prairielearn`, а не с устаревшего master. Повторный вызов в том же workspace использует закреплённый manifest. Новый запрос актуальных refs требует нового workspace.

Для сравнения подготовьте отдельные clean Git worktrees владельцев: `upstream` на GitHub baseline, `clean-control` с удалённой прежней телеметрией, `candidate` с фасадами. Java SHA и содержимое сценария одинаковы. Создайте локальный JSON inputs; каждая из трёх mappings должна перечислять все шесть репозиториев из baseline. Например, структура одного элемента:

```json
{
  "baseline": ".workspace/baseline/manifest.json",
  "variants": {
    "upstream": {"BSU-RFCT-Afonenko-Courses/Java": "/absolute/upstream/Java"},
    "clean-control": {"BSU-RFCT-Afonenko-Courses/Java": "/absolute/upstream/Java"},
    "candidate": {"BSU-RFCT-Afonenko-Courses/Java": "/absolute/upstream/Java"}
  },
  "runtimeRegistry": {
    "path": "/absolute/prairielearn-platform/runtime-profiles.json",
    "version": "v2.0.0 / b971a61a2386fbf4ae7fcfc9394d307359bc7889"
  }
}
```

Дополните каждую mapping пятью владельцами `Afonenko-Course-Tools/quarto-course`, `quarto-project-publish`, `quarto-reference-catalog`, `quarto-project-download`, `quarto-course-prairielearn`. `freeze` проверяет HEAD и чистоту, сохраняет хеши native инструментов и registry, создаёт общий experiment id; ранее закреплённый эксперимент не перезаписывает.

```sh
deno task perf freeze --workspace .workspace/java --inputs /absolute/inputs.json
deno task perf run --workspace .workspace/java --scenario java-full-student --variant candidate --mode off
deno task perf run --workspace .workspace/java --scenario java-full-full --mode summary
deno task perf run --workspace .workspace/java --scenario java-ast-document --mode trace
deno task perf run --workspace .workspace/java --scenario java-ts-publication --mode trace
deno task perf run --workspace .workspace/java --scenario java-ts-publication --mode cpu
deno task perf run --workspace .workspace/java --scenario java-pl-export --mode summary
```

Все фактически установленные копии `_extensions` находятся и заменяются в disposable Java copy. Receipts фиксируют owner SHA, package hash и destination paths; symlinks в package/course input запрещены. Изменённый checkout или runtime hash прерывает подготовку. Копирование и очистка output находятся вне измеряемого интервала. Каждый диагностический запуск получает snapshot backend и copy Quarto share/data-dir со своими хешами.

`java-repeat-student` повторно использует outputs внутри benchmark series; функциональную проверку двух запусков одной copy выполняет `tools/repeat-java.ts`; остальные render сценарии очищают только перечисленные `cleanPaths`. Env старых и новых profiler очищается, функциональные env и course profile сохраняются. PL экспорт использует закреплённый внешний registry и пишет локальную поставку в `{run_output}`. `{course_root}`, `{run_output}`, `{runtime_registry}` заменяются внутри argv, без shell evaluation.

## Парные измерения и отчёт

```sh
deno task perf benchmark --workspace .workspace/java --scenario java-ast-document --pairs 10 --seed 42
deno task perf benchmark --workspace .workspace/java --scenario java-full-student --pairs 5 --seed 42
deno task perf benchmark --workspace .workspace/java --scenario java-full-full --pairs 5 --seed 42
deno task perf report --workspace .workspace/java
deno task perf verify --workspace .workspace/java
```

Benchmark сравнивает `clean-control`/`candidate`; `--left upstream` задаёт отдельное сравнение для legacy затрат. В каждом варианте исключённый прогрев, затем AB/BA пары. Hyperfine запускает argv с `--shell none`, одну измеряемую команду на invocation и сохраняет raw schema 2 JSON. Runner сохраняет partial series после каждой пары; итог содержит run ids и median парных ratios. Bootstrap: 10 000 resamples, seed 42, 95% CI. Верхняя граница ≤1.01 означает PASS; нижняя >1.01 — FAIL; пересечение — INCONCLUSIVE. Код CLI benchmark 5 означает FAIL/INCONCLUSIVE, а не ошибку сборки.

CLI: 0 — команда выполнена, 2 — configuration/preparation error, 3 — исходная сборка завершилась неуспешно, 4 — invalid diagnostic data, 5 — overhead не подтверждён. Оригинальный build exit code и signal остаются в `run.json`.

В отдельных runs GNU time измеряет CPU/RSS инструмента вместе с внешним помощником сохранения native child status (`resourceScope` указан явно); wall относится к запуску самого инструмента. Помощник нужен для различения сигнала и числового exit code независимо от версии GNU time. В Hyperfine benchmark запускается непосредственно обычная команда без этого помощника; исходный signal в его JSON недоступен (`signalAvailability: unavailable`), exit code сохраняется.

Отчёт содержит `manifest.json`, `builds.json`, `summary.json`, `coverage.json`, `quality.json`, `benchmarks.json` и Markdown. Для каждого diagnostic run — отдельные `wall.trace.json` и `lua-cpu.trace.json`; их можно загрузить в Perfetto. Raw processes, profiles, events, stdout/stderr, preparation receipts и установленные копии остаются рядом с run. Невалидные/прерванные измерения сохраняются и не превращаются в PASS.

## Как читать данные

- TS wall измеряется монотонными process clocks с calibration. Неопределённость включает интервал локального чтения epoch, но не ограничивает системный дрейф между процессами. Lua `pandoc.system.cputime` возвращает пикосекунды; агент переводит их в микросекунды **до** арифметики. При отсутствии provider используется `os.clock`; precision отмечена как provider-dependent. Lua CPU не совмещается с TS wall.
- `calls.*`, `walk_api_calls.{full-document,fragment,block,inline,unknown}`, `filter_runs` и `handler_calls.*` — разные счётчики. Root scope объявляется в конкретном call site; Pandoc-typed fragment не считается full document. Дополнительного обхода AST ради размера нет. `node_visits` остаётся null. Summary/cpu не обрамляют поузловые filter handlers; document phases и shortcode boundaries сохраняются. Поузловые handler counts доступны при явном trace.
- Inclusive интервалы могут вкладываться и перекрываться. Их сумма не является временем сборки. Async self time недоступно. Deno CPU samples не являются точными call counts.
- `coverage.complete` относится только к выбранному scope. Unsupported TS generators/constructors/accessors/decorators/direct eval, локальные/aliased manual rebindings и inline manual callbacks перечислены в skipped; strict scope отказывает перед запуском. Исключение ручной разметки из auto trace поддержано для module-level function declarations. Summary регистрирует semantic операции, а не все функции. Compiler API загружается только для преобразования выбранного TS trace scope. TS symbol mapping содержит исходные ranges; универсальная sourcemap реконструкция transpiled CPU строк не реализована. Lua same-line функции имеют отдельную runtime identity; ordinal первого наблюдения не обещает стабильности между runs.
- Lua-корутины наследуют span создателя и сохраняют отдельные стеки. `coroutine.wrap` сохраняет нативную функцию и результаты; доступ к её thread identity проверен в Pandoc/Lua 5.4. Tail caller сохраняется как логический родитель до завершения callee, включая ошибку. Остановка trace снимает hooks с зарегистрированных корутин и отмечает незавершённые функции как aborted.
- Lua sampling backend недоступен; обычный Pandoc debug hook обеспечивает выбранную call trace. Агент не устанавливает конфликтующие hooks. SIGTERM/INT дают best-effort flush; SIGKILL не гарантирует записи. Потери буфера и незавершённые spans делают данные invalid.
- Значимые outputs сравниваются строго; allowlist нормализует только два выявленных набора HTML attribute order. Учебный текст, ответы, ссылки и значения атрибутов остаются строгими. ZIP сравнивается по именам и распакованным bytes.

## Развитие и владельцы

[Согласованный план](docs/plan/README.md), [реестр ручных операций](docs/operation-registry.json). Канонический ABI 1 — `bridge/bridge.ts` и `bridge/bridge.lua`. Проверка одинаковых локальных копий:

```sh
deno run -A tools/sync-bridge.ts --check /absolute/quarto-course /absolute/quarto-project-publish /absolute/quarto-reference-catalog /absolute/quarto-project-download /absolute/quarto-course-prairielearn
```

`tools/instrument-owners.ts` — однократная миграция первоначальных owner PR. На уже размеченных исходниках она отказывает; дальнейшие semantic операции добавляются вручную с owner behaviour tests. В обычные packages входят только фасады и ручная разметка. Каждый владелец сохраняет свои contracts и native CI; совместная проверка Java выполняется на согласованном наборе immutable SHAs.

## Проверка outputs и повторного render

После benchmark и diagnostic builds:

```sh
deno run -A tools/repeat-java.ts /absolute/experiment-workspace
deno run -A tools/validate-java.ts /absolute/experiment-workspace /absolute/upstream-workspace
```

Первая команда выполняет два реальных student render одной disposable copy без очистки outputs и сравнивает результат. Вторая сравнивает upstream/control/candidate/summary полных профилей, выбранные off/trace/cpu и PL export. Upstream из предыдущего эксперимента допускается только при совпадении immutable source SHAs. Внутренние profiles/events проверяются также внутри ZIP. Эти функциональные проверки не заменяют парный overhead benchmark.

[Отчёт Java](docs/java-pilot-report.md) и [матрица требований](docs/requirements-status.md) фиксируют текущие результаты, ограничения и ссылки на связанные PR.
