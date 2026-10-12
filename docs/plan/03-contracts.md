# Контракты измерений

Связанные документы: [архитектура](02-architecture.md), [проверки](07-validation.md), [решения](09-decisions.md).

## Конфигурация сценария

```typescript
type Mode = "off" | "summary" | "cpu" | "trace";
type CachePolicy = "clean-output" | "repeat-render";
type Variant = "upstream" | "clean-control" | "candidate";
interface SourceRequest {
  repository: string;              // owner/repo в GitHub
  refPolicy: "remote-default-head" | "explicit-remote-ref";
  ref?: string;                    // только при explicit-remote-ref
}
interface Scenario {
  id: string;
  project: "Java";
  cwd: string;                     // относительный путь внутри копии курса
  executable: "quarto";
  args: string[];
  courseProfile: "student" | "full";
  cachePolicy: CachePolicy;
  mode: Mode;
  scope: { modules: string[]; extensions: string[]; strict: boolean };
  resources: { wall: boolean; cpu: boolean; peakRss: boolean };
}
```

Не называть `clean-output` холодным дисковым кешем: удаляются только явно перечисленные outputs/cache в disposable workspace, OS page cache не очищается. `repeat-render` сохраняет результаты предыдущего рендера. Зависимости заранее доступны в обоих случаях.

## Идентификаторы и источники

- `experiment_id`: одно сравнение на замороженном наборе входов.
- `run_id`: один действительный запуск команды; профили разных запусков не объединяются в один run.
- `process_id`: уникальный ID процесса в run, отдельно хранится OS pid и parent_process_id.
- `executor_id`: TS-process либо отдельный Lua state/coroutine.
- `span_id`: один интервал операции; `parent_span_id` может пересекать границу процесса при подтверждённой передаче контекста.
- `operation_id`: стабильное семантическое имя, например `course-core.pedagogy.collect`.
- `symbol_id`: символ исходного кода; привязан к repository, revision, path и позиции. Для сравнения между ревизиями применяется отдельное сопоставление; строка файла сама по себе не стабильный ключ.
- `document_id`: путь от корня курса + output format + course profile. Созданный фрагмент имеет собственный root_id и исходный document_id.

В манифесте: repository URL, remote ref, SHA, package path/hash, установленные destination paths, tool version/hash, ABI, mode, scope, cache policy, argv, runtime capabilities и разрешённые overrides env. Не сохранять всю среду окружения или секреты.

Для диагностического запуска сохранять отдельные preparation receipts: kind (`bootstrap`, `ts-transform`, `quarto-adapter`), путь, hash исходного файла, hash подготовленного файла и source map при наличии. Owner SHA/package hash относится к исходному installable пакету; изменённая временная копия не выдаётся за побайтно тот же пакет. Подготовка не меняет immutable исходники эксперимента.

## Минимальный ABI фасада: версия 1

```typescript
interface OperationSpec {
  id: string;
  kind: "phase" | "function" | "ast_walk" | "io" | "command";
}
interface WalkSpec extends OperationSpec {
  kind: "ast_walk";
  scope: "full-document" | "fragment" | "block" | "inline" | "unknown";
}
interface Metrics {
  wrapSync<T extends (...args: any[]) => any>(spec: OperationSpec, fn: T): T;
  wrapAsync<T extends (...args: any[]) => Promise<any>>(spec: OperationSpec, fn: T): T;
  wrapWalk<T extends (...args: any[]) => any>(spec: WalkSpec, fn: T): T;
  childEnv(base: Record<string, string>): Record<string, string>;
}
declare function createMetrics(extensionId: string, abiVersion?: 1): Metrics;
```

Lua соответствует по смыслу: `create_metrics(extension_id, 1)`, `wrap_sync(spec, fn)`, `wrap_walk(spec, fn)`, `child_env(base)`. Async wrapper в Lua отсутствует; корутины учитывает агент.

Нормативный off-path: `wrapSync(spec, fn) === fn`, `wrapAsync(spec, fn) === fn`, `wrapWalk(spec, fn) === fn`; в Lua — равенство объектов функций. `childEnv(base)` возвращает тот же объект/таблицу. Никаких часов, событий, активного контекста, JSON или hooks.

Фасад ищет заранее установленный агент ABI 1 в process/state registry. Не скачивает и не динамически загружает агент сам. Диагностический launcher устанавливает его до загрузки размеченных модулей. Несовместимость ABI или отсутствие agent при requested mode делает данные диагностического запуска невалидными; обычный режим остаётся самодостаточным.

Sync wrapper не преобразует значение в Promise. Async wrapper сохраняет fulfilled value и исходный объект ошибки; изменение идентичности Promise в diagnostic mode документируется. В off исходный Promise и функция сохраняются буквально. Дополнительные async-границы не должны попадать в обычную сборку.

Lua wrappers сохраняют число результатов и `nil` между ними. При ошибки агента исходная ошибка бизнес-кода имеет приоритет; внутренняя телеметрия не должна скрыть её.

## Среда диагностического запуска

Зарезервированы `COURSE_PERF_MODE`, `COURSE_PERF_EXPERIMENT_ID`, `COURSE_PERF_RUN_ID`, `COURSE_PERF_PARENT_PROCESS_ID`, `COURSE_PERF_PARENT_SPAN_ID`, `COURSE_PERF_OUTPUT_DIR`, `COURSE_PERF_AGENT_TS`, `COURSE_PERF_AGENT_LUA`, `COURSE_PERF_SCOPE_FILE`. Это ключи нового механизма, а не существующий API Quarto.

Runner задаёт только свои overrides; базовая среда курса сохраняется, секреты не протоколируются. Diagnostic launchers создают process ID, передают родительские ID и сохраняют stdin/stdout/stderr, cwd, argv, коды выхода и сигналы.

Для off очищать унаследованные `COURSE_PERF_*` диагностические значения и известные profiling overrides Quarto (`QUARTO_REPORT_PERFORMANCE_METRICS`, `QUARTO_REPORT_PERFORMANCE_METRICS_FILE`, `QUARTO_PROFILER_OUTPUT`, `QUARTO_COMBINED_LUA_PROFILE`), а также старый `COURSE_BUILD_TRACE`. Не очищать настройки профиля курса и функциональные env произвольным wildcard. Дополнительные profiling keys свежего runtime выявляются capabilities discovery.

`QUARTO_DENO` и `QUARTO_PANDOC` используются только после capabilities probe выбранного Quarto. Сохранять прямые пути к настоящим бинарникам, чтобы launcher не вызвал сам себя. TS command boundary добавляет span context через `childEnv`; прямые внешние процессы без такого boundary получают process relation либо пометку `unlinked`, а не выдуманную точную причинную связь.

## События

```typescript
interface Event {
  schema_version: 1;
  experiment_id: string;
  run_id: string;
  process_id: string;
  executor_id: string;
  sequence: number;
  event: "begin" | "end" | "counter" | "quality";
  kind: "phase" | "function" | "ast_walk" | "io" | "command";
  span_id?: string;
  parent_span_id?: string;
  operation_id?: string;
  symbol_id?: string;
  document_id?: string;
  origin: "manual" | "auto" | "runtime";
  clock_domain: "monotonic_process" | "process_cpu" | "none";
  timestamp_us?: number;
  status?: "ok" | "error" | "aborted";
  counter?: { name: string; value: number; quality: "observed-exact" | "partial" };
  attributes?: Record<string, string | number | boolean | null>;
}
```

Counter value — приращение; при экспорте агрегированного summary указываются область и количество завершённых/аварийных запусков. Отсутствующее наблюдение — `null`/`not-observed`, а не нулевой счётчик.

Сырые журналы сохраняются по `runs/<run_id>/events/<process_id>/<executor_id>.jsonl`, metadata/summary — рядом с executor. ID генерируются системой и безопасны как имена файлов. Native CPU profiles хранятся отдельными артефактами, с receipt и ссылкой из run metadata; samples не преобразуются в ложные `begin/end` Event.

Разделить `walk_api_calls`, `filter_runs`, `handler_calls.<type>`, `node_visits`. Последнее значение отсутствует, если native walker не инструментирован. Корень типа `Pandoc` может содержать фрагмент; тип объекта не определяет scope автоматически. Использовать объявленный WalkSpec и диагностический контекст.

## Часы

TS: `performance.now()` для локальных длительностей, независимая привязка к общей wall шкале и сохранение погрешности калибровки. Межпроцессные часы нельзя склеивать одним общим нулём без калибровки.

Lua: `pandoc.system.cputime()` при доступности, иначе явно обозначенный `os.clock()` с записанной точностью. Это **CPU-время процесса**, не wall-clock и не гарантированно собственное CPU-время одной Lua-функции. Не включать CPU-интервалы Lua в `wall.trace.json`.

Решение Q-01 принято: на первом этапе TS и Lua анализируются раздельно. Высокоточный wall clock provider Lua не входит в пилот. Общий манифест и подтверждённые причинные связи сохраняются, но CPU-интервалы Lua и wall-интервалы TS не совмещаются и не суммируются. `lua-cpu.trace.json` имеет собственную шкалу и явно подписан как CPU-время процесса.

Времена родителей, детей, ожиданий и параллельных ветвей не складываются арифметически. Self time для async можно выводить только из проверенного учёта активного исполнения/объединения интервалов, иначе значение `not-available`. Разность memory snapshots не считается памятью функции.

## Качество и завершение

Агент сохраняет counters и буферизованный trace раздельно, сообщает dropped_events и incomplete spans. Запись на каждом вызове функции непосредственно на диск запрещена. Finalizer выполняет доступный flush при normal exit и ошибке; SIGKILL не обещает полный flush.

Telemetry failure не заменяет значение/ошибку сборки. Runner хранит `build_exit_code` отдельно от `data_valid`; успешный render с повреждённым trace не является успешным измерением. CLI: 0 — валидный результат, 2 — config/preflight, 3 — ошибка сборки, 4 — невалидные измерения, 5 — провал критериев сравнения. Дочерние launcher сохраняют реальный код запущенной программы.

## CLI проекта

```text
deno task perf sources --config scenarios/java.json
deno task perf run --scenario java-full-student --mode off --variant candidate
deno task perf benchmark --scenario java-full-student --left clean-control --right candidate
deno task perf run --scenario java-ast-document --mode trace --variant candidate
deno task perf report --experiment <experiment-id>
deno task perf verify --experiment <experiment-id>
```

Это будущие интерфейсы, их нельзя запускать до реализации задач. Идентификаторы сценариев зафиксированы в [04](04-sources-and-java-pilot.md); выбранные document paths разрешаются во время source discovery.
