# Performance: план реализации

> **Для агента-исполнителя:** выполнять задачи по очереди с `superpowers:executing-plans`, если этот навык доступен. Использование subagents допускается только при разрешении пользователя/действующих инструкций. Для каждой задачи сначала написать проверку существенного поведения, подтвердить её падение, реализовать минимальное решение, выполнить проверку и сохранить логический коммит. Шаги отмечать флажками.

**Цель:** создать отдельный гибридный проект измерения, подготовить согласованные owner PR и подтвердить достоверность измерений и малую стоимость выключенной разметки на актуальной Java.

**Архитектура:** самодостаточные локальные фасады в расширениях, внутренние агенты и runner отдельно, внешние ordinary benchmark и целевая подробная трассировка. TS и Lua временные данные на первом этапе раздельны. Источники берутся из GitHub при начале реализации и фиксируются для эксперимента.

**Технологии:** TypeScript/Deno выбранного Quarto, Lua выбранного Pandoc, Hyperfine 2 или проверенный совместимый измеритель, файловые JSON/JSONL, закреплённый совместимый TypeScript Compiler API для временной инструментализации, Chrome trace format для экспорта.

**Спецификация:** [01-requirements.md](01-requirements.md), [02-architecture.md](02-architecture.md), [03-contracts.md](03-contracts.md).

## Общие ограничения

- Нормативные значения `mode`: `off`, `summary`, `cpu`, `trace`.
- Источник исходников — GitHub на момент начала реализации; SHA фиксируется для эксперимента, не навечно в плане.
- Пилот измеряется локально на Linux x86-64. Пользовательские рабочие деревья сохраняются.
- В off фабрики возвращают исходную функцию; агент, hooks, таймеры метрик и журналы отсутствуют.
- Распространяемые пакеты не зависят от внутреннего проекта, сети или отдельного Performance extension.
- На первом этапе TS и Lua временные данные раздельны; native wall clock provider Lua не разрабатывается.
- `walk_api_calls`, `filter_runs`, `handler_calls` и `node_visits` — разные показатели.
- Цель off overhead ≤ 1%; PASS/FAIL/INCONCLUSIVE определены в [07](07-validation.md).
- Не объединять разные run в один trace и не выдавать samples за точные вызовы.
- Серьёзные внутренние изменения разрешены; обычные функциональные результаты проверяются.
- Сейчас создаётся план. При его последующей реализации подготовить reviewable PR; merge/публикация/релизы не входят в этот этап.

## Основные риски для рецензирования

1. Дочерние проекты используют собственные `_extensions`; частичное обновление создаёт смешанный набор версий — T-01/T-05.
2. Async branching, рекурсия и Lua tail calls могут исказить вложенность — T-03/T-04.
3. Ошибка/exit/signal или повреждённый журнал могут выглядеть как успешное измерение — T-03/T-06/T-09.
4. Временный bootstrap/transformer может изменить import.meta.main, hoisting, this или ошибки — T-03/T-08.
5. Смешение CPU/wall, inclusive времени и статистического шума может создать ложный вывод — T-07/T-09/T-10.

## Интерфейсы, используемые задачами

`Mode`, `Variant`, `SourceRequest`, `Scenario`, `Event`, `Metrics`, `OperationSpec`, `WalkSpec` определены в [03](03-contracts.md) и переносятся в `src/config/types.ts` / `src/protocol/types.ts` без переименования полей.

Дополнительные типы фиксируются задачей-владельцем:

```typescript
interface SourceReceipt {
  repository: string;
  sourceKind: "github-baseline" | "local-candidate";
  remoteRef: string;
  sha: string;
  baseSha?: string;
  fetchedAt: string;
  checkoutPath: string;
}
interface PackageReceipt {
  repository: string;
  ownerSha: string;
  extensionId: string;
  sourcePath: string;
  packageHash: string;
  destinationPaths: string[];
}
interface SourceManifest {
  experimentId: string;
  sources: SourceReceipt[];
  packages: PackageReceipt[];
  runtime: Record<string, { path: string; version: string; hash: string }>;
}
interface PreparedVariant {
  variant: Variant;
  root: string;
  manifest: SourceManifest;
}
interface RunResult {
  runId: string;
  buildExitCode: number;
  dataValid: boolean;
  outputDirectory: string;
  preparation: PreparationReceipt[];
}
interface PreparationReceipt {
  kind: "bootstrap" | "ts-transform" | "quarto-adapter";
  path: string;
  sourceHash: string;
  preparedHash: string;
  sourceMapPath?: string;
}
interface BenchmarkComparison {
  medianRatio: number;
  interval95: [number, number];
  status: "PASS" | "FAIL" | "INCONCLUSIVE";
  pairs: number;
}
interface PairedMeasurement {
  order: "AB" | "BA";
  controlWall: number;              // секунды
  candidateWall: number;            // секунды
  controlRunId: string;
  candidateRunId: string;
}
interface BenchmarkSeries {
  pairs: PairedMeasurement[];
  seed: number;
}
```

Сериализация raw Event использует snake_case из протокола; CLI/runner types — camelCase, как выше. Преобразование явно покрывается тестом, не выполняется автоматическим глобальным переименованием.

## T-01. Свежие исходники, упаковка и рабочие варианты

**Файлы Performance:** создать `deno.json`, `deno.lock`, `src/config/types.ts`, `src/config/validate.ts`, `src/sources/resolve.ts`, `src/sources/snapshot.ts`, `src/sources/packages.ts`, `scenarios/java.json`, `tests/sources/resolve.test.ts`, `tests/sources/packages.test.ts`.

**Интерфейсы:** `resolveSources(requests: SourceRequest[], workspace: string): Promise<SourceManifest>`; `prepareVariant(manifest: SourceManifest, variant: Variant, workspace: string): Promise<PreparedVariant>`. Производит immutable receipt и упаковку всех установок расширений. Потребляет политику [04](04-sources-and-java-pilot.md).

- [ ] Прочитать fresh AGENTS/current spec владельцев, получить remote default heads из GitHub, зафиксировать inventory и capabilities. Пример локального пути из разговора не использовать как источник.
- [ ] Написать тест `resolves_remote_tip_and_freezes_manifest`: fake remote имеет две версии, повторный resolve внутри одного experiment не меняет зафиксированный SHA.
- [ ] Написать тест `installs_all_subproject_copies`: root и два дочерних проекта получают одинаковый owner/package receipt; старая child-копия не остаётся незаметно активной.
- [ ] Написать тест `rejects_unsafe_destination`: путь вне disposable workspace, symlink escape и путь с пробелами; первый/второй отклоняются, третий корректно обрабатывается.
- [ ] Запустить `deno test -A tests/sources` и подтвердить отсутствие реализации/падение проверок.
- [ ] Реализовать resolver/packager; Git операции выполняются argv, без сборки shell command из пользовательских строк. Выбор refs — по [04](04-sources-and-java-pilot.md).
- [ ] Повторить tests, выполнить свежую upstream сборку Java и сохранить commands/evidence. Несовместимость upstream не скрывать.
- [ ] Сохранить логический коммит и source manifest. Структуру и реальные paths синхронизировать с текущими owner контрактами.

## T-02. Протокол и локальные фасады ABI 1

**Файлы:** `src/protocol/types.ts`, `src/protocol/validate.ts`, `bridge/bridge.ts`, `bridge/bridge.lua`, `tools/sync-bridge.ts`, `tests/protocol/events.test.ts`, `tests/bridge/off.test.ts`, `tests/fixtures/bridge-off.lua`.

**Интерфейсы:** API `createMetrics`/`Metrics` и Lua API из [03](03-contracts.md). `validateEvent(value: unknown): Event`; `syncBridge(ownerRoots: string[], checkOnly: boolean): Promise<void>`.

- [ ] Написать tests `off_returns_original_function`, `off_does_not_access_agent_or_clock`, `off_returns_original_env`, `abi_mismatch_is_explicit`. Для Lua — сравнить объекты функций и число/nil возвращаемых значений.
- [ ] Написать `event_clock_domain_is_required`, `unobserved_counter_is_not_zero`, `counter_is_delta`. Ошибочные values должны отклоняться.
- [ ] Запустить `deno test -A tests/protocol tests/bridge` и Lua fixture через выбранный Pandoc; подтвердить падение без реализации.
- [ ] Реализовать минимальный фасад с registry ABI 1. Никакого собственного collector, clock или import внутреннего агента в распространяемых файлах.
- [ ] Реализовать генерацию локальных копий из единого канонического шаблона; checkOnly выявляет drift и не переписывает файлы.
- [ ] Повторить тесты, проверить normal package contents и сохранить коммит.

## T-03. TS-агент, bootstrap и сохранение контекста

**Файлы:** `src/agents/ts/bootstrap.ts`, `src/agents/ts/agent.ts`, `src/agents/ts/context.ts`, `src/agents/ts/writer.ts`, `src/runner/context.ts`, `tests/agents/ts.test.ts`, `tests/fixtures/ts/{entrypoint,branches,errors}.ts`.

**Интерфейсы:** агент реализует `Metrics`, registry ABI 1; `installTsAgent(config: AgentConfig): void`, где `AgentConfig = { experimentId: string; runId: string; processId: string; outputDirectory: string; mode: Mode }`. `prepareTsBootstrap(entrypointPath: string, bootstrapPath: string): Promise<PreparationReceipt>` изменяет только диагностическую рабочую копию и возвращает receipt этой подготовки.

- [ ] Написать тесты `parallel_async_branches_have_distinct_contexts`, `sync_wrapper_preserves_this_and_error`, `async_wrapper_preserves_value_and_rejection`, `recursive_spans_have_correct_parent`.
- [ ] Написать интеграционные fixtures `bootstrap_preserves_import_meta_main_and_args`, `duplicate_bridge_paths_share_one_agent`, `agent_failure_does_not_replace_build_error`.
- [ ] Запустить `deno test -A tests/agents/ts.test.ts` и подтвердить падение нужных проверок.
- [ ] Реализовать AsyncLocalStorage/стек и буферизованный writer; facade registration вне тел функций. Не делать async wrapper для sync API.
- [ ] Добавить bootstrap первым import во временный entrypoint, сохраняя shebang, entrypoint identity и относительные импорты. Зафиксировать symbol/source mapping вставки и PreparationReceipt с before/after hash.
- [ ] Проверить normal exit, `Deno.exit`, rejected Promise и SIGTERM/SIGKILL fixtures; partial/aborted должны отражаться в quality. SIGKILL не обещает flush.
- [ ] Повторить проверки и сохранить коммит. В off не выполняется bootstrap preparation/agent import.

## T-04. Lua-агент, CPU-часы и точная трассировка

**Файлы:** `src/agents/lua/init.lua`, `agent.lua`, `writer.lua`, `clock.lua`, `trace.lua`; `tests/agents/lua.test.ts`; `tests/fixtures/lua/{returns,nested-walk,coroutines,tail-errors}.lua`.

**Интерфейсы:** `install_lua_agent(config)`, registry ABI 1, CPU clock `now_cpu_us()` и metadata о provider/precision. AgentConfig соответствует T-03, дополнительно отдельный executor_id для state/coroutine.

- [ ] Написать fixtures с `nil` внутри multiple returns, вложенной функцией, tail call, двумя корутинами и исключением из callback.
- [ ] В fixture nested walk проверить ожидаемые точные `walk_api_calls`: один full-document, два fragment, правильные родительские span. Callback count остаётся отдельным.
- [ ] Запустить `deno test -A tests/agents/lua.test.ts`; fixtures выполняются реальным выбранным Pandoc, а не standalone Lua с иным API.
- [ ] Реализовать CPU clock на доступном `pandoc.system.cputime`, с честно отмеченным fallback/precision. Native wall clock и объединение с TS не реализовывать.
- [ ] Реализовать call/return hook для выбранного scope, стеки корутин, tail-call handling и error unwinding. Обработчик исключает собственную телеметрию, но не теряет frames native границ.
- [ ] Bootstrap через дополненную копию data-dir/init.lua: сохранить штатный init и проверить отдельные states/filter/shortcode загрузки.
- [ ] Проверить outputs/error identity, normal/off отсутствие hook, partial data при exit; сохранить коммит.

## T-05. Чистые owner изменения и ручная разметка

**Файлы владельцев:** current `_extensions/<id>/observability/bridge.ts|lua`; текущие filter/entrypoints/application/infrastructure функции из [06](06-extension-prs.md); owner tests/current spec/README.

**Интерфейсы:** потребляет ABI 1; производит operation registry, объявленные WalkSpec, command propagation и `clean-control`/`candidate` refs для каждого изменённого владельца.

- [ ] Инвентаризировать собственные explicit walks, entrypoints, subprocess и legacy timers во fresh исходниках. Назначить stable operation_id, отдельно root scope и source position.
- [ ] Для каждого owner сначала написать/обновить behaviour tests на сохранение outputs, errors, process args/cwd/env и partial render контрактов; подтвердить, что они выявляют намеренную поломку.
- [ ] Выполнить необходимые чистые внутренние рефакторинги и замену legacy telemetry. Обновить внутренние потребители/tests и сохранить clean-control commits **до** добавления фасадов.
- [ ] Добавить локальные шаблоны фасада и регистрацию значимых операций на уровне модулей. Явные AST walks перевести на helpers без измерительных обходов и off per-node instrumentation.
- [ ] Проверить внутренние aliases/recursion и регистрацию callback. Не утверждать полный function coverage на основании одного экспортного wrapper.
- [ ] Выполнить owner checks, ABI drift check и package-self-contained tests. Повторить student/full на согласованном комплекте всех owners.
- [ ] Сохранить candidate commits; документировать actual paths/operation registry/изменённые внутренние контракты. Не отправлять владельцам смешанные packages разных ABI.

## T-06. Runner, launchers и внешние benchmark

**Файлы:** `src/cli.ts`, `src/runner/prepare.ts`, `execute.ts`, `benchmark.ts`; `src/launchers/deno.ts`, `pandoc.ts`; `tests/runner/{execute,launchers,benchmark}.test.ts`.

**Интерфейсы:** `executeScenario(scenario: Scenario, prepared: PreparedVariant, mode: Mode): Promise<RunResult>`; `benchmarkPair(scenario: Scenario, left: PreparedVariant, right: PreparedVariant, options: { pairs: number; seed: number }): Promise<BenchmarkSeries>`. Runner собирает сырые пары; статистику вычисляет T-07, поэтому зависимости от ещё не реализованной аналитики нет.

- [ ] Написать fake-tool tests на argv/cwd/env/stdin/stdout/stderr, оригинальный exit code, путь с пробелами и запуск дочернего процесса.
- [ ] Написать `off_clears_inherited_profiler_environment`, `launcher_does_not_recurse`, `each_child_profile_has_unique_output`, `benchmark_preparation_is_outside_interval`.
- [ ] Написать tests AB/BA schedule, одинаковое состояние copy/cache, отдельные run_id на каждый вызов и соответствие source/prepared hashes. В off preparation receipts пусты.
- [ ] Запустить `deno test -A tests/runner` и подтвердить падение до реализации.
- [ ] Реализовать штатное исполнение и capabilities-checked diagnostic launchers; CPU flags только для подходящего Deno command. QUARTO_PROFILE и COURSE_PERF_MODE не смешивать.
- [ ] Подключить Hyperfine raw JSON с доступными ресурсами; AB/BA порядок задаёт runner. Не обещать total tree RSS.
- [ ] Проверить actual Quarto nested run/render и shutdown/timeout поведение; сохранить коммит.

## T-07. Нормализация, аналитика и раздельные отчёты

**Файлы:** `src/analysis/normalize.ts`, `aggregate.ts`, `compare.ts`, `outputs.ts`; `src/report/markdown.ts`, `perfetto.ts`; `tests/analysis/{quality,clocks,compare,outputs}.test.ts`.

**Интерфейсы:** `normalizeRun(directory: string): Promise<NormalizedRun>`; `NormalizedRun = { runId: string; events: Event[]; dataValid: boolean; quality: QualitySummary }`; `QualitySummary = { droppedEvents: number; incompleteSpans: number; coverageComplete: boolean; errors: string[] }`. `compareBenchmarks(ratios: number[], seed: number): BenchmarkComparison`; `writeExperimentReport(manifest: SourceManifest, runs: NormalizedRun[], output: string): Promise<void>`.

- [ ] Написать tests ID uniqueness, mismatched end, partial JSONL, cross-run parent, dropped events и unobserved values.
- [ ] Написать `lua_cpu_never_enters_wall_trace`, `inclusive_children_not_double_counted`, `async_self_time_is_unavailable_without_active_intervals`.
- [ ] Написать comparison fixtures: все ratios 1.00 → PASS, все 1.02 → FAIL, пересекающий 1.01 interval → INCONCLUSIVE; seed фиксирован, 10 000 resamples.
- [ ] Написать outputs fixture: технический timestamp нормализуется, изменение учебного текста/ответа/target link остаётся различием.
- [ ] Запустить `deno test -A tests/analysis` и подтвердить падение до реализации.
- [ ] Реализовать проверку протокола, aggregation и отдельные `wall.trace.json`/`lua-cpu.trace.json`. Shared experiment manifest не выравнивает часы Lua и TS.
- [ ] Сформировать Markdown summary, coverage/quality и raw evidence links; открыть trace в Perfetto и проверить labels/clock domains.
- [ ] Сохранить коммит после passing tests.

## T-08. Целевая автоматическая TS-инструментализация

**Файлы:** `src/instrumentation/ts/transform.ts`, `symbols.ts`, `coverage.ts`; `tests/instrumentation/ts.test.ts`; `tests/fixtures/instrumentation/{ordinary,async,hoisting,unsupported}.ts`.

**Интерфейсы:** `instrumentModule(source: string, path: string, scope: { strict: boolean }): InstrumentedModule`; `InstrumentedModule = { source: string; symbols: SymbolReceipt[]; skipped: { position: number; reason: string }[] }`; `SymbolReceipt = { id: string; path: string; start: number; end: number; manuallyWrapped: boolean }`.

- [ ] Выбрать реальные TS-модули пилота и составить список синтаксических конструкций; закрепить совместимую версию Compiler API в internal lock.
- [ ] Написать differential tests original/instrumented: обычная функция, async, lexical closure, recursion, ранний return, default args, this, error object, вызов до declaration/hoisting, module exports и import.meta.main.
- [ ] Написать `manual_wrapper_is_not_duplicated`, `strict_scope_rejects_unsupported`, `source_map_points_to_original`. Не создавать ложный нулевой call count для skipped символа.
- [ ] Запустить `deno test -A tests/instrumentation` и подтвердить падение проверок.
- [ ] Реализовать преобразование только диагностических файлов. Трансформер использует проверенную семантику wrapper из T-02/T-03; не вставляет наивный try/finally вокруг async return, который завершился бы до Promise.
- [ ] Unsupported generators, decorators, constructors или иные конструкции, если они не реализованы и проверены, отражаются в coverage; strict scope с такими конструкциями не запускается как полный.
- [ ] Выполнить trace выбранного настоящего Java TS-модуля, сопоставить source и preparation receipts, проверить значимые outputs против original; сохранить коммит.

## T-09. Диагностические адаптеры Quarto и CPU-профили

**Файлы:** `src/adapters/quarto/capabilities.ts`, `filter-trace.ts`; `tests/runner/cpu.test.ts`, `tests/agents/quarto-traversal.test.ts`; internal документация backends.

**Интерфейсы:** `probeQuarto(runtimePath: string): Promise<QuartoCapabilities>`; `QuartoCapabilities = { runtimeHash: string; denoCpu: boolean; luaHook: boolean; luaSampling: boolean; filterAdapter: boolean }`.

- [ ] Написать tests неподдерживаемого runtime, частично доступного backend, skipped filter и фильтра, который вызывает только Pandoc callback без полного traversal.
- [ ] Запустить проверку и подтвердить падение до реализации.
- [ ] Добавить TS CPU profiles для всех наблюдаемых Deno процессов, с source mapping/известными ограничениями transpiled line numbers.
- [ ] Сделать Quarto filter-run adapter в диагностической копии; различать run_emulated_filter и реальные walk API calls, не считать каждый фильтр обходом.
- [ ] Проверить standard Lua hook trace отдельно от sampler. Не устанавливать одновременно конфликтующие hooks.
- [ ] Lua sampling backend: описать проверенную сборку соответствующих Lua/Pandoc, converter и зависимости; если он не подготовлен, report `unavailable`, оставить остальные режимы рабочими. Не брать численные production benchmark из специального binary.
- [ ] Подтвердить, что runtime patches/agents отсутствуют в ordinary execution и package outputs; сохранить коммит.

## T-10. Java integration и проверка накладных расходов

**Файлы:** `scenarios/java.json`, `tests/integration/java.test.ts`, `evidence/<experiment-id>/`, итоговый integration report. Изменения course config — только если действительно нужны и в отдельном Java PR.

**Интерфейсы:** потребляет T-01—T-09, source manifests и три variants. Производит actual evidence и acceptance results.

- [ ] Записать окончательные реальные paths документов/под проектов и команды из свежих контрактов. Проверить неизменность workload во всех variants.
- [ ] Выполнить upstream/clean-control/candidate-off full student/full и проверку значимых outputs.
- [ ] Выполнить summary на полном student/full и проверить покрытие всех подключённых owners и процессов. Экспорты проверяются отдельным сценарием, если подключены.
- [ ] Выполнить отдельные TS CPU и Lua CPU/trace представления, целевую automatic TS trace; проверить quality/coverage и output equivalence.
- [ ] Выполнить off A/B по [07](07-validation.md): 10 пар representative workload и 5 пар каждого полного профиля; AB/BA порядок, raw evidence и bootstrap interval.
- [ ] При шуме увеличить до предусмотренного лимита либо сохранить INCONCLUSIVE и обсудить следующий шаг; не объявлять acceptance завершённым.
- [ ] На synthetic 1×/2×/4× проверить счётчики повторных walks/парсинга; зафиксировать один найденный bottleneck либо честный результат «не выявлен».
- [ ] Обновить README и отчёт фактическими командами/ограничениями, сохранить коммит.

## T-11. Рецензия, PR и передача

**Файлы:** README/current spec владельцев, PR bodies, `docs/java-pilot-report.md` Performance, ссылки на evidence и manifests.

**Интерфейсы:** итоговый список repository/branch/commit/PR URL и status проверок; все зависимости между PR объяснены.

- [ ] Перечитать implementation против R-01—R-18: каждое требование имеет доказательство или явный unresolved status.
- [ ] Выполнить актуальные owner checks, ABI drift/package audit и обязательные CI checks; записать действительные результаты.
- [ ] Провести review source/env handling, семантики, clock domains, coverage, overhead и normal package dependencies. Без отдельного reviewer назвать проверку self-review, не независимой рецензией.
- [ ] Подготовить/открыть reviewable PR в реально изменённых owners и Performance project по [06](06-extension-prs.md). Не делать merge, Releases, публикацию или чистку unrelated branches.
- [ ] Передать список PR, отчёт Java, raw evidence, acceptance статусы и точные ограничения. При FAIL/INCONCLUSIVE не помечать цель как достигнутую.

## Порядок и точки остановки

T-01 → T-02 → T-03/T-04 → T-05 → T-06 → T-07 → T-08 → T-09 → T-10 → T-11. Независимость задач не даёт автоматического разрешения на subagents. Новое существенное расхождение source/API/семантики сначала документируется и обсуждается, но routine implementation choices исполнитель принимает самостоятельно.

После T-07 уже полезны benchmark и обзор на Java. Это промежуточный результат, а не выполнение всего пилота: T-08/T-09 добавляют обещанную углублённую диагностику, T-10/T-11 завершают проверки и PR.
