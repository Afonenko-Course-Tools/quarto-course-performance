# План обобщения quarto-course-perf и подготовки Arch-пакета

> **Для исполнителя:** обязательный навык — `superpowers:subagent-driven-development`
> или `superpowers:executing-plans`. Выполнять задачи по порядку и отмечать
> результат флажками. Этот документ описывает будущую реализацию.

**Цель:** из каталога Quarto-проекта запускать `quarto-course-perf render`,
получать готовый отчёт в `.quarto/course-perf` и при необходимости открывать
диагностику в Perfetto без подготовки отдельного Java-эксперимента.

**Архитектура:** добавить отдельный путь нативного рендера, переиспользующий
узкие функции существующего backend. Сборщики, нормализация и материалы одного
запуска общие для простого рендера и расширенного эксперимента. Владельцы
расширений сохраняют свои границы; новый общий runtime не создаётся.

**Технологии:** TypeScript/Deno, Pandoc Lua, публичные API Quarto, GNU time,
Linux `setsid` из `util-linux`, Arch `makepkg`, Chrome Trace Event JSON.

**Спецификация:** [простой рендер и установка](../specs/2026-10-17-general-use-design.md).
Визуализация выполняется по отдельному [плану Perfetto](2026-10-17-perfetto-visualization.md)
на шаге 10 этого плана. Он не заменяет остальные задачи.

## Общие ограничения

- Команда и Arch-пакет — `quarto-course-perf`, репозиторий — `quarto-course-performance`.
  Новый интерфейс и конфигурация выпускаются как `2.0.0`.
- Простой `render` выполняется на месте; исходные cwd, native argv, профили,
  функциональное окружение, cache/freeze и сеть сохраняются.
- Собственные `--perf-` читаются только в начальном префиксе. Режим по умолчанию
  `off`; простые диагностические режимы — `summary` и `cpu`.
- Данные текущего запуска полностью собираются вне проекта, сохраняются после
  остановки дерева в `<project-root>/.quarto/course-perf/runs/<run-id>` либо
  в `<perf-output>/<run-id>`. Старые данные в `.quarto` могут очищаться Quarto.
- Установленные пакеты и исходники не заменяются командой измерения. Переход
  Java на новые расширения — отдельное подготовительное действие задачи 8.
- Основная приёмка опирается на обновлённый Java. Cybersecurity, его обновление,
  рендеры и новый PR отложены прямым указанием пользователя от 2026-10-17.
- Базовый toolchain — Quarto `1.11.5` и bundled Deno `2.7.14`; системный Deno
  `2.9.7` проверяется отдельно. Версии фиксируются в новых evidence.
- ABI остаётся `1`; raw Event и executor-summary сохраняют `schema_version: 1`.
  Новые config/source manifest/run/summary имеют `schema_version: 2`,
  sidecar производного экспорта `export.json` — `schema_version: 1`.
- CPU Lua и wall TS не совмещаются в одну шкалу. Безвременные счётчики и peak RSS
  остаются агрегатами. SDK просмотрщика в курсы не добавляется.
- Новые README, документация и PR — по-русски. Исторические evidence,
  `docs/plan`, теги и Releases не переписываются. Корневой каталог не становится Git-репозиторием.
- Работа ведётся в существующих репозиториях владельцев с сохранением рабочих
  деревьев. Изоляцию реализации готовить штатным worktree-механизмом.

## Главные случаи для ревью

1. Значение native-флага или второй `--` ошибочно принято за цель/опцию оболочки:
   argv остаётся буквальным; проверки задач 2–3.
2. Пользовательский Deno/Pandoc/data-dir потерян из-за подключения диагностики:
   сохраняются эффективные runtime и `init.lua`; проверки задач 3 и 6.
3. Прерывание оставило пишущего внука либо затронуло соседний процесс терминала:
   останавливается только собственное дерево; проверки задачи 4.
4. Quarto удалил `.quarto` или финальное сохранение не удалось: текущие raw
   остаются во внешнем staging, ссылки действуют после переноса; задачи 5 и 10.
5. Обновление Java затёрло candidate-правку либо отчёт приписал ему версии main
   владельцев: полные пакеты, точные hashes и проверка поведения; задачи 1, 8 и 12.

## Файлы и границы изменений

| Файлы | Ответственность |
| --- | --- |
| `src/cli.ts`, новые `src/cli/arguments.ts`, `src/cli/experiment.ts` | Ленивая маршрутизация и два независимых интерфейса |
| Новый `src/adapters/quarto/inspect.ts`, `capabilities.ts` | Цель проекта и фактически выбранный runtime |
| Новые `src/runner/render.ts`, `process.ts`, `storage.ts` | Нативный запуск, процессы/потоки, staging/finalize |
| `resource-child.ts`, `launchers/{setup,tool}.ts`, `runner/environment.ts` | Ресурсы, сигналы, публичная установка агентов |
| `config/types.ts`, новый `src/report/types.ts`, `protocol/{types,validate}.ts` | Явные версии машинных форматов и optional context |
| `bridge/`, `agents/{ts,lua}/`, `runner/diagnostic.ts` | Контекст, receipts ожиданий и состояние покрытия |
| `analysis/{normalize,report}.ts`, новый `src/report/run.ts` | Проверенные интервалы и материалы одного запуска |
| `config/validate.ts`, `sources/`, `analysis/{compare,outputs}.ts` | Обобщённые эксперименты и явная политика сравнения |
| `docs/operation-registry.json` и узкие файлы владельцев | Согласованная разметка без нового механизма исполнения |
| Новые `packaging/arch/`, `src/assets.ts`, `tools/check-installed.ts` | Поставка исходников, assets и автономная проверка |
| `tools/check-java-general-use.ts`, `tests/`, `.github/workflows/check.yml` | Маленькие fixtures и итоговая приёмка Java |
| README, новые `docs/{arch-package,diagnostics,experiments,migration,development}.md` | Короткий пользовательский маршрут и подробности по ссылкам |

## Задача 1 — закрепить исходники и машинные контракты

**Файлы:** `src/config/types.ts`, новый `src/report/types.ts`,
`tests/protocol/events.test.ts`, новые `tests/report/formats.test.ts`,
`docs/evidence/general-use-inputs.json` и `docs/general-use-formats.md`.

**Интерфейсы:** сохранить raw Event v1. В `report/types.ts` определить
`SimpleMode = "off" | "summary" | "cpu"`, `NativeRenderRequest`
`{cwd:string; quarto:string; nativeArgv:string[]; mode:SimpleMode; outputParent?:string}`,
`BuildOutcome` `{code:number; signal:Deno.Signal|null; wallSeconds:number;
cpuUserSeconds:number|null; cpuSystemSeconds:number|null; peakRssKiB:number|null}`.
`RunRecord` v2 хранит runId, запрос, outcome, preparation, качество, версии,
Git provenance, `collectionDirectory` и итоговый `outputDirectory` раздельно.

- [ ] На GitHub перепроверить heads/теги владельцев и Java PR #16; закрепить
  полные SHA, descriptors и применимые контракты в новых inputs. Исходная точка
  аудита: Performance `409afa12dddee5cf20528efef24e7e0639fffcc7`, Core
  `aebf6f4580c0bd5e9468498e840221619fc69e5f`, PrairieLearn
  `69924dbda56ed55fb556f2e0932565eafbdb6448`, Java PR #16
  `7a5a2d5e700261868827465add54970f0dfd025e`. Локальный старый Core index не
  заменяет контракты этих refs. Java head — начало подготовки, не итоговая матрица версий.
- [ ] Сохранить hashes пользовательских деревьев и отдельно перечислить
  candidate-правки Java Core/PrairieLearn: что уже вошло в новые выпуски и что
  требуется перенести. Не стирать их установкой пакетов поверх рабочего дерева.
- [ ] Добавить тест `formats distinguish current metadata from raw v1`:
  `run.schema_version === 2`, `summary.schema_version === 2`,
  `event.schema_version === 1`; неизвестная версия явно отклоняется.
- [ ] Запустить `deno test -A tests/report/formats.test.ts tests/protocol/events.test.ts`;
  подтвердить отказ новой проверки на прежнем metadata-контракте.
- [ ] Ввести перечисленные типы и документировать обязательные поля/null,
  единицы, delta против total и правило исторического чтения. Старые unversioned
  metadata читаются только явным адаптером импорта для `experiment report/verify`;
  raw/evidence не перезаписываются. Не связывать версию CLI с ABI или Event schema.
- [ ] Повторить узкие проверки и зафиксировать отдельный коммит.

## Задача 2 — простой CLI без скрытой Java-конфигурации

**Файлы:** `src/cli.ts`, новые `src/cli/{arguments,experiment}.ts`,
`tests/cli/arguments.test.ts`, `tests/runner/lazy.test.ts`.

**Интерфейсы:** `parseCommand(argv:readonly string[]):Command` в `arguments.ts`.
`Command` — union `help`, `version`, `render` с `mode/outputParent/nativeArgv`,
`experiment` с прежними расширенными аргументами. `main(argv:string[]):Promise<number>`
диспетчеризует маршруты; зависимости эксперимента загружаются только внутри его ветки.

- [ ] Добавить тесты начального `--perf-` префикса, двух форм значения,
  повторов/неизвестных параметров и native-остатка. Закрепить:
  `parseCommand(["render","--perf-mode=summary","--to","html"]).nativeArgv`
  равно `["--to","html"]`; `["render","--","--","topic.qmd"]` оставляет
  `["--","topic.qmd"]`. После первого native-аргумента оболочка ничего не изымает.
- [ ] Добавить проверки top-level help/version без Quarto, проекта, config и
  сети; `render --help` передаётся Quarto до inspect/staging и не создаёт отчёт.
  Native `--help` после native-разделителя не выдавать за запрос справки.
- [ ] Запустить `deno test -A tests/cli/arguments.test.ts tests/runner/lazy.test.ts`;
  подтвердить ошибки прежней ранней загрузки `scenarios/java.json`.
- [ ] Реализовать parser и маршрутизацию. Полный `trace` простого render
  отклонять с русским указанием изолированного `experiment run --mode trace`.
  Старый parser перенести в `experiment.ts`, не применять его к native argv.
- [ ] Повторить проверки, включая отсутствие npm/compiler-загрузки в help/off;
  зафиксировать коммит.

## Задача 3 — проект и эффективное окружение через публичные интерфейсы

**Файлы:** новый `src/adapters/quarto/inspect.ts`, `capabilities.ts`,
`src/runner/environment.ts`, новые `tests/runner/project.test.ts` и
`tests/runner/environment.test.ts`.

**Интерфейсы:** `resolveRenderProject(request:NativeRenderRequest):Promise<ProjectTarget>`;
`ProjectTarget` содержит `projectRoot:string`, `kind:"project"|"standalone"`.
`probeQuarto(quarto:string, env?:Record<string,string>)` сохраняет вызывающее
окружение; `validateTelemetryEnvironment(env)` возвращает конфликты без мутации.

- [ ] Добавить fixtures: cwd проекта/обычной подпапки, самостоятельный nested
  проект, цель другого проекта, standalone файл, пробелы, `--to html`,
  `--output-dir`, `--key=value`, профиль из argv и `QUARTO_PROFILE`.
  `render --to html` не рассматривает `html` как путь; native argv после resolver
  побайтно равен исходному. Неоднозначность входа даёт объяснимую ошибку до рендера.
- [ ] Проверить, что `QUARTO_DENO`, `QUARTO_PANDOC`, `QUARTO_SHARE_PATH`, Deno
  options, XDG cache и сетевые настройки не стираются. Telemetry conflict
  отклоняется отдельно от допустимого функционального override.
- [ ] Запустить `deno test -A tests/runner/project.test.ts tests/runner/environment.test.ts`;
  подтвердить отказ на старом очищении env и отсутствии resolver.
- [ ] Реализовать узкое извлечение цели/профилей и `quarto inspect [path]`.
  Не передавать inspect произвольные render-флаги и не импортировать private
  Quarto-код. Чужие native-параметры оставлять Quarto; resolver не становится
  вторым валидатором всей CLI. Эффективные binaries проверять только для нужного режима.
- [ ] Повторить проверки и зафиксировать коммит.

## Задача 4 — нативный запуск, потоки, ресурсы и собственное дерево процессов

**Файлы:** новые `src/runner/{render,process}.ts`, `resource-child.ts`,
`src/launchers/tool.ts`, новые `tests/runner/render.test.ts`,
`tests/runner/process.test.ts`, существующие `launchers.test.ts`.

**Интерфейсы:** `runNativeRender(request:NativeRenderRequest, stagingDirectory:string,
diagnosticEnv?:Record<string,string>):Promise<BuildOutcome>`.
Supervisor `runOwnedProcess` в `process.ts` принимает executable/argv/cwd/env/log paths,
запускает отдельную Linux session/group через `setsid` и возвращает фактический
child outcome. Общий Linux helper остаётся внутри существующего backend.

- [ ] Сначала воспроизвести и диагностировать существующий SIGTERM-тест
  `tests/runner/launchers.test.ts` на Deno 2.7.14 и 2.9.7. В аудите он завершился
  `null !== SIGTERM`; не ослаблять assertion и не объявлять причиной sandbox без проверки.
- [ ] Добавить fixtures: ранний stdout/stderr виден до завершения, большой вывод
  не буферизуется целиком, stdin и перенаправление сохраняются, PTY не ломает
  интерактивность. Служебный текст отсутствует в stdout.
- [ ] Добавить прерываемое дерево child→grandchild с записью heartbeat и соседний
  контрольный процесс. После SIGINT/SIGTERM heartbeat своего дерева прекращается,
  сосед жив, отчёт различает numeric exit `7` и завершение сигналом.
- [ ] Запустить `deno test -A tests/runner/process.test.ts tests/runner/render.test.ts tests/runner/launchers.test.ts`;
  подтвердить новые отказы, затем реализовать streaming tee, stdin, readiness
  receipt группы, очередь раннего сигнала и ожидание остановки принадлежащих потомков.
  Групповой сигнал не дублировать отдельной пересылкой каждому child; чужую
  foreground group терминала не использовать. Эскалация зависшего своего дерева
  фиксируется в outcome; временные материалы сохраняются и при прерывании.
- [ ] Использовать GNU time при наличии; без него `cpuUserSeconds`,
  `cpuSystemSeconds`, `peakRssKiB` равны `null`, wall измеряется отдельно.
  Отсутствие `setsid` даёт ошибку подготовки. Не менять outputs/cache/network,
  не добавлять повторный рендер или Hyperfine в простой путь.
- [ ] Повторить проверки на обеих версиях Deno; зафиксировать коммит только
  после прохождения signal-регрессии.

## Задача 5 — внешний staging и единые материалы запуска

**Файлы:** новый `src/runner/storage.ts`, новый `src/report/run.ts`,
`src/analysis/report.ts`, `src/config/types.ts`, `tests/analysis/report.test.ts`,
новые `tests/runner/storage.test.ts`, `tests/report/run.test.ts`.

**Интерфейсы:** `prepareRunStorage(request, target):Promise<RunPaths>` возвращает
`{runId,stagingDirectory,finalDirectory}`; `finalizeRun(paths,record):Promise<string>`
возвращает итоговый каталог либо оставляет staging и сообщает его путь.
`writeRunArtifacts(directory:string, record:RunRecord,
normalized?:NormalizedRun):Promise<void>` в `report/run.ts` пишет непосредственно
в каталог одного запуска. `writeExperimentReport(manifest,runs,output)` сохраняет
сигнатуру и вызывает этот общий построитель для `output/runs/<id>`.

- [ ] Добавить тест standalone `--output-dir`, который удаляет всю `.quarto`:
  текущие logs/raw/report сохраняются после остановки дерева, старый run может
  исчезнуть, чужой scratch не восстанавливается и `--no-clean` не добавляется.
- [ ] Проверить relative `--perf-output` от исходного cwd, запрет записи,
  file/symlink/output collision, разные проекты и два одновременных run-id.
  При сбое finalize staging существует и его путь напечатан; child exit `7`
  остаётся `7`, successful child с потерей обязательного отчёта даёт код Performance `4`.
  После сохранения доступных данных CLI повторно поднимает исходный SIGINT/SIGTERM
  на себе, а не выдаёт сигнал за обычный numeric exit. Ошибка отчёта не скрывает
  исходный ненулевой код или сигнал Quarto; ошибка подготовки имеет код `2`.
- [ ] Добавить проверки report в off без NormalizedRun, отсутствие лишнего
  `runs/<id>` внутри simple-run, работа всех относительных ссылок после переноса,
  абсолютный `collectionDirectory` как provenance отдельно от нового outputDirectory.
- [ ] Проверить Git state до создания результата: dirty/non-Git разрешены,
  `.gitignore` не меняется, служебная история не выдаётся за изменение исходников.
  `resources:["**"]` не публикует `.quarto`; иной perf-output внутри resources
  обнаруживается до запуска без переписывания конфигурации.
- [ ] Запустить `deno test -A tests/runner/storage.test.ts tests/report/run.test.ts tests/analysis/report.test.ts`;
  подтвердить отказы, реализовать staging/finalize и общий builder с versioned
  run/summary. Raw и preparation receipts не переписывать ради исправления путей.
- [ ] Проверить повторно, включая async-stream эксперимента: текущий run
  обрабатывается до чтения следующего. Зафиксировать коммит.

## Задача 6 — публичное подключение summary/cpu

**Файлы:** `src/runner/diagnostic.ts`, `src/adapters/quarto/{capabilities,filter-trace}.ts`,
`src/launchers/{setup,tool}.ts`, `src/agents/lua/init.lua`,
`tests/agents/quarto.test.ts`, `tests/runner/launchers.test.ts`.

**Интерфейсы:** `prepareRenderDiagnostic(request,target,workspace)` возвращает
`{env,preparation,coverage}` без преобразования пользовательских TS/Lua.
`prepareDiagnostic` остаётся адаптером расширенного эксперимента. Приватный
`prepareFilterAdapter` доступен только явно ограниченной диагностике эксперимента,
не является условием подключения обычных агентов summary/cpu.

- [ ] Добавить тест `simple summary works without private Quarto filter adapter`:
  owner operation наблюдается, `quarto.filter.run` помечен недоступным, копия
  private `main.lua` не патчится. `cpu` дополнительно создаёт настоящий V8 profile.
- [ ] Добавить регрессию пользовательского `--data-dir` обеих форм и `init.lua`
  с `CUSTOM_INIT=true`: без измерения и с summary/cpu выполнение успешно,
  пользовательский init выполняется ровно один раз; оригинальное дерево не меняется.
- [ ] Запустить `deno test -A tests/agents/quarto.test.ts tests/runner/launchers.test.ts`;
  подтвердить прежний сбой data-dir, затем разделить установку агента и private
  filter span. Использовать публичные Deno preload и Pandoc init/data-dir hooks;
  готовить копию эффективного data-dir конкретного вызова вне проекта.
- [ ] Сохранить активные пользовательские binaries/share/options. Неподдерживаемый
  выбранный runtime или конфликт существующей диагностики даёт понятную ошибку
  до измеряемой сборки; не подменять его bundled binary молча.
- [ ] Повторить проверки и сравнение значимых native outputs; зафиксировать коммит.

## Задача 7 — контекст ABI 1, ожидания и достоверное покрытие

**Файлы:** `bridge/{bridge.ts,bridge.lua}`, `src/agents/{ts/agent.ts,lua/agent.lua}`,
`src/protocol/{types,validate}.ts`, `src/runner/diagnostic.ts`, `src/launchers/tool.ts`,
`src/analysis/{normalize,report}.ts`, `docs/operation-registry.json`,
`tests/bridge/off.test.ts`, `tests/agents/{ts,lua}.test.ts`, `tests/analysis/quality.test.ts`.

**Интерфейсы:** optional `OperationSpec.document_id?:string` и
`OperationSpec.attributes?:Record<string,string|number|boolean|null>`;
`createMetrics(extensionId)` связывает facade с `attributes.extension_id`.
Для Lua публичный документный контекст читается при вызове, для TS передаётся
в операции там, где owner знает документ. `expectations.json` v2 перечисляет
фактически запрошенные/поддержанные/активированные агенты процесса и ожидаемые
summary/profile; начальные receipts создаются до исполнения дочернего кода,
факт исполнения/завершения дописывается после наблюдения. В `report/types.ts`
определить `ProcessExpectation` с полями `process_id:string`,
`agent:"ts"|"lua"`, `requested/supported/activated/executed:boolean`,
`summary_path?:string`, `profile_path?:string` и
`DiagnosticExpectations` `{schema_version:2;processes:ProcessExpectation[]}`.
`ValidatedInterval` в `analysis/normalize.ts` содержит `begin:Event`, `end:Event`,
`durationUs:number`; `validatedIntervals(run:NormalizedRun):ValidatedInterval[]`
используется агрегированием и экспортом.

- [ ] Добавить тесты recorded extension/document context и его отсутствия,
  параллельных документов без утечки контекста, старого bridge/нового агента,
  нового bridge/старого агента. В off возвращаются исходные функции, Promise
  и base env; ABI остаётся 1. Необязательные поля не требуют новой ABI.
- [ ] Добавить проверку TS `childEnv` вне активного span: старый
  `COURSE_PERF_PARENT_SPAN_ID` из base удалён, parent process соответствует текущему;
  поведение согласовано с Lua. Trace Lua сравнивает нормализованную идентичность
  файла вместо substring scope.
- [ ] Добавить fixtures no-child/freeze/help/no-markup: dataValid не становится
  false только из-за отсутствия наблюдений. Потерянный ожидаемый summary/profile
  остаётся ошибкой. Различать installed/instrumented/observed/integrity, не
  выставлять `coverage.complete=true` заранее.
- [ ] Добавить отрицательные пары begin/end: другой run/process/executor/operation/
  clock, дубликат, отрицательное время и незавершённый begin. Общий помощник
  `validatedIntervals(run)` в `analysis/normalize.ts` возвращает
  только подтверждённые пары; totals и exporter используют его, raw остаются полными.
- [ ] Запустить `deno test -A tests/bridge tests/agents tests/protocol tests/analysis/quality.test.ts`;
  подтвердить отказы и реализовать context, ожидания и качество без фабрикации
  документных IDs, timestamps и родительских связей. Prefix-based owner
  attribution старых событий обозначать `derived`, отдельно от recorded.
- [ ] Синхронизировать registry: добавить существующие
  `course-navigation.filter.handler.Pandoc` и
  `course-site.infrastructure.navigation.addressNavigation`; проверить IDs/paths
  по закреплённым owners. Удалённых зарегистрированных Core/PL операций аудит
  не обнаружил. Итоговые counter totals не суммировать второй раз с delta events.
- [ ] Повторить узкие проверки и зафиксировать коммит.

## Задача 8 — узкие изменения владельцев и обновлённый Java

**Файлы:** canonical `observability/bridge.{ts,lua}` у Core/Presentation/Navigation,
Publisher, QRC, Download, PrairieLearn; соответствующие owner tests. Для childEnv:
Download `infrastructure/files.ts`, PrairieLearn `entrypoints/{export-course,inspect-grading}.ts`,
Print/Moodle `infrastructure/process.ts`, Cloud `validate.lua` под их `_extensions`.
В Print/Moodle создать `observability/bridge.ts`, в Cloud — `observability/bridge.lua`
из того же канона, поскольку в исходной точке этих файлов нет. Document context
добавлять в подтверждённые per-document границы, включая Core
`infrastructure/native-run.ts`; пакетная операция над несколькими документами
сохраняет общий контекст без выбора одного произвольного документа.
У Java — штатный installer, `installed-packages.json`, `UPSTREAM.md` и provider patches.

**Интерфейсы:** владельцы используют optional контекст задачи 7; полные пакеты
устанавливаются отдельно от измерения. Разметка сообщает документ только при
однозначном входе. Пакеты без semantic markup честно остаются без такого покрытия.

- [ ] В изолированных owner checkouts обновить канонические фасады и добавить
  узкие проверки document/extension/child context; все копии совпадают с каноном.
  Не размечать каждую функцию Print/Moodle/Cloud ради заявления «полное покрытие».
- [ ] Исправить перечисленные неохваченные subprocess boundaries через
  `childEnv/child_env` и узкую operation boundary там, где нужен подтверждённый
  родитель; для Lua использовать публичную scoped-передачу окружения дочернему
  вызову, не глобальную мутацию env. При неизвестном контексте оставить unlinked.
  Новая command-only разметка не означает наблюдение всех функций пакета. Выполнить тесты каждого
  затронутого владельца; новые PR/README/контракты описать по-русски.
- [ ] Подготовить согласованные выпуски затронутых расширений, сохранив ABI 1.
  На Java отдельно выполнить переход с исходных Core7.1.0/PL7.0.0 и candidate
  patches на актуальные согласованные полные пакеты, включая новое наблюдение.
  Обновления Core7.2.0/PL7.1.0 из аудита служат исходными версиями сверки, а не
  обещанием окончательной версии будущего выпуска.
- [ ] Перенести только ещё необходимые candidate-правки штатным путём владельца,
  не редактировать vendored файлы курса по одному. Зафиксировать итоговые Java SHA,
  owner tags/SHAs, hashes пакетов, scopes и patch provenance. Сохранить исходную
  Java ветку/рабочее дерево и все её незакоммиченные изменения.
- [ ] Прогнать обычный Java render `student → full → student` до измерений;
  проверить starter-проекты, учебное содержимое и отсутствие регрессии candidate
  функциональности. Ошибка обновления курса не объявляется ошибкой Performance.
- [ ] Зафиксировать отдельные owner/Java commits и новые inputs приёмки.
  Cybersecurity и его PR не изменять. Измеряемый render не выполняет ни один
  из этих шагов обновления автоматически.

## Задача 9 — обобщённые изолированные эксперименты

**Файлы:** `src/config/{types,validate}.ts`, `src/cli/experiment.ts`,
`src/sources/{prepare,packages,freeze,snapshot}.ts`, `src/analysis/{compare,outputs,report}.ts`,
`scenarios/java.json`, `tests/runner/config.test.ts`, `tests/sources/`,
`tests/analysis/{compare,outputs}.test.ts`.

**Интерфейсы:** config v2 задаёт `projectSource:string` — repository из `sources`;
`replacements:{repository:string;extensionId:string;destinations:string[]}[]`;
`benchmark?:{pairs?:number;maxSlowdownRatio:number}` и
`outputPolicy?:"strict"|"java-pilot-core-qrc-v1"`.
`SourceManifest` v2 переносит projectSource и replacements. `Scenario` теряет
`project:"Java"` и `courseProfile`; native профиль остаётся в args.
`installPackages(root,owners,replacements)` меняет только явные destinations.
Диагностический `capabilities` также переходит под `experiment`, но не требует
Java-конфигурации, manifests или Hyperfine.

- [ ] Добавить fixtures проекта с другим именем, без owner replacement,
  со сторонним установленным расширением и с двумя mappings одного destination.
  Прежние пакеты сохраняются; неоднозначность, symlink и выход за root
  отклоняются до первой замены. SHA/runtime/hash проверки сохраняются.
- [ ] Добавить тесты действия без Hyperfine, единого default pairs `10`, явного
  `maxSlowdownRatio`, strict comparison и opt-in исторической нормализации.
  Отсутствие benchmark policy при сравнении даёт ошибку; 1% живёт только в
  мигрированном Java-пилоте как `1.01`, а не в общей функции сравнения.
- [ ] Добавить исключение `.quarto/course-perf` для новых source snapshots,
  copy/treeHash; проверить отсутствие результатов прошлого измерения во входах.
  Политику исходного снимка не применять к обходу events или копии runtime;
  исторические receipts/hash algorithms задним числом не менять.
- [ ] Запустить `deno test -A tests/runner/config.test.ts tests/sources tests/analysis/compare.test.ts tests/analysis/outputs.test.ts`;
  подтвердить отказы, затем реализовать v2, явную подготовку и dependency probes
  по действию: Git/unzip для соответствующих sources, Hyperfine только benchmark.
- [ ] Однократно мигрировать Java-пример и инструменты разработчика, обращающиеся
  к прежнему CLI. Для исторических manifests сделать явный read-only импорт
  в report/verify; не поддерживать вторую живую CLI/config-схему.
- [ ] Повторить проверки и настоящий ограниченный trace на обновлённом Java
  только в отдельной копии. Зафиксировать коммит.

## Задача 10 — Perfetto и Speedscope

**Файлы и интерфейсы:** выполнить задачи 1–4
[плана визуализации](2026-10-17-perfetto-visualization.md). Он потребляет
контекст/ожидания задачи 7 и `writeRunArtifacts` задачи 5; общий exporter не
создаёт отсутствующие контекст, CPU/memory samples или родительские связи.

- [ ] Пройти проверки дорожек/часов/flows, повреждённых пар, original IDs,
  versioned `export.json` с исходными IDs и delta/total без двойного счёта.
- [ ] Сформировать представления через общий run builder и проверить ссылки
  после staging→final для simple и experiment отчётов.
- [ ] Выполнить реальный импорт закреплённым Perfetto v58.2 и открыть его UI;
  открыть настоящий Java CPU profile в Speedscope. Зафиксировать версии и
  фактические результаты без требования установить viewer для самого render.
- [ ] Выполнить проверки отдельного плана и зафиксировать коммит.

## Задача 11 — устанавливаемое дерево и Arch-рецепт

**Файлы:** новые `src/assets.ts`, `packaging/arch/{PKGBUILD,quarto-course-perf}`,
`tools/prepare-arch-source.ts`, `tools/check-installed.ts`, `tests/packaging/installed.test.ts`,
`deno.lock`, `deno.json`, `src/launchers/setup.ts`, `src/runner/{diagnostic,execute}.ts`,
`docs/arch-package.md`.

**Интерфейсы:** `assetPath(relative:string):string` в `src/assets.ts` разрешает
assets относительно приложения через `fileURLToPath`; installed root содержит
`src`, `bridge`, registry, config/lock и local node_modules.
`tools/check-installed.ts --root /absolute/path` проверяет распакованное дерево,
не требует системной установки. Launcher не делает `cd` в каталог приложения.

- [ ] Добавить failing installed-tree fixture с пробелами, чужим `deno.json`,
  новым пустым Deno cache и запретом загрузки модулей. Проверить top-level help,
  настоящий render и TS trace изолированного эксперимента. Хеши дерева установки
  до/после равны, `/usr` не используется для runtime writes.
- [ ] Запустить `deno test -A tests/packaging/installed.test.ts`; подтвердить
  старые `.pathname`/неполные backend assets, затем исправить все места поиска
  файлов, включая subprocess helper и копию backend. Передавать app config/lock,
  `--node-modules-dir=manual` и `--cached-only` всем собственным Deno entrypoints.
- [ ] Закрепить npm versions, архивы и SHA-256 в source рецепта; подготовить
  offline node_modules при сборке. Не скачивать зависимости установленным
  приложением и не использовать `deno compile` вместо выбранного file-tree.
- [ ] Описать зависимости `deno`, провайдер `quarto`, `time`, `util-linux`;
  Hyperfine/Git/unzip относятся к расширенным действиям. Не выдумывать лицензию
  вместо отсутствующей у проекта; отдельно отразить это в инструкции и metadata.
- [ ] Подготовить локальный source archive точного commit и собрать `makepkg -s`
  обычным пользователем; проверить `makepkg --packagelist`, `pacman -Qlp`,
  `namcap`, paths `/usr/bin`, `/usr/lib/quarto-course-perf`, `/usr/share/doc/quarto-course-perf`.
  Затем проверить распакованное дерево и чистую Arch-среду при доступности.
- [ ] Написать проверенные русские инструкции сборки/установки/обновления/удаления.
  Не заявлять pacman-install по одной распаковке; установка на ноутбук и AUR
  не входят в этот шаг. Выполнить installed checks и зафиксировать коммит.

## Задача 12 — Java, короткая документация и выпуск

**Файлы:** новый `tools/check-java-general-use.ts`,
`docs/evidence/general-use-validation.json`, `README.md`,
`docs/{arch-package,diagnostics,experiments,migration,development}.md`,
`deno.json`, `.github/workflows/check.yml` и штатная документация владельцев.

**Интерфейсы:** `tools/check-java-general-use.ts --project /absolute/checkout
--output /absolute/evidence` принимает закреплённый обновлённый Java задачи 8,
работает с изолированными копиями для воспроизводимых сравнений и сохраняет
SHA/toolchain/packages/команды/коды/хеши результатов. Оно не обновляет проект.

- [ ] Проверить root Java обоих профилей native и off; summary на root student
  для Publisher→nested projects, cpu на существующем вложенном проекте/lecture.
  После перехода подтвердить реальные цели: root, theory, tasks, lectures,
  practice, handbook. В source head аудита есть `lectures/platform-runtime.qmd`,
  `theory/chapters/platform.qmd`, `practice/numbers.qmd`, `handbook/entries/values.qmd`;
  при подготовке новой ревизии записать фактические цели заново.
- [ ] Проверить разные формы cwd/target: `lectures`, явный каталог из корня,
  файл из корня, обычная подпапка `theory/chapters`. Отчёт относится к выбранному
  native project. Сравнивать учебное содержимое и starter ZIP строго; перечень
  динамических native-файлов фиксировать явно, не скрывать расхождения общей HTML-нормализацией.
- [ ] Проверить isolated trace и explicit replacement отдельно; подтверждать
  context/coverage по исполнению, а не только существованию registry symbols.
  Проверки отсутствующей разметки/произвольного профиля/no-Git и аварийных случаев
  выполняются маленькими fixtures без второго большого курса.
- [ ] Переписать только основной README Performance: назначение, Arch-установка,
  одна команда, пример результата, режимы и короткие ссылки на подробности.
  Описать переход 1.0→2.0, очистку `.quarto`, offline assets и ограничения часов.
- [ ] Выполнить `deno task check`, `deno task test`, Java/Perfetto/installed checks
  на финальном исходнике. CI запускать на финальных этапах; исходный SHA и
  реально прошедшие проверки записать в evidence, не подменять текущим старым пилотом.
- [ ] Провести независимое code review и закрыть найденные проблемы; создать
  выпуск Performance2.0.0 с проверенным Arch-рецептом и согласованные owner
  releases. Документацию опубликовать штатным маршрутом в существующую `gh-pages`
  владельца; не создавать новый сайт/runtime только для Performance.
- [ ] Проверить опубликованные артефакты и ссылки. Очищать только завершённые
  LOCAL/REMOTE ветки инструментов/шаблона после сохранения истории; сохранить
  main, serving gh-pages, ветки OPEN автоматических PR, теги/Releases и все
  пользовательские course worktrees/ветки. Cybersecurity отложен и не блокирует этот выпуск.

## Порядок исполнения и граница приёмки

Общие типы → CLI → native resolver → lifecycle → staging/report → публичная
диагностика → context/coverage → владельцы и переход Java → experiments →
визуализация → Arch → итоговая Java-проверка и выпуск. Независимые owner-изменения
можно делегировать после закрепления ABI; общие файлы редактируются последовательно.

Успех означает действующую установленную команду и проверенный результат на
обновлённом Java. Наличие этого плана и успешное создание JSON сами по себе
не подтверждают реализацию, корректность данных или совместимость viewer.
Cybersecurity возвращается в матрицу отдельным этапом после обновления его расширений.
