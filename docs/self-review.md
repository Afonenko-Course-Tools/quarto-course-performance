# Самопроверка реализации

Проверку выполнил implementer; независимая рецензия не заявляется. Итоговые
результаты запусков и ограничения находятся в [отчёте Java](java-pilot-report.md)
и [матрице требований](requirements-status.md). Критерий R-16 отложен
пользователем 13 октября 2026 года; это не подтверждение предела ≤1%.

| Область | Что проверено | Доказательства |
| --- | --- | --- |
| Источники и установка | Явный согласованный Java PR13; frozen SHA, dirty/head guards, runtime hashes, owner/package receipts каждой installed copy; контроль из другого эксперимента принимается только с совпадающими SHA | source fixtures, manifests, `tools/check-owners.ts`, outputs validation |
| Обычный режим | Фабрики TS/Lua возвращают исходную функцию; отказ env permission сохраняет off; Compiler API загружается только для selected TS trace; agents/hooks/profiles не распространяются с расширениями | off/native fixtures, ABI audit семи пакетов, owner CI |
| Семантика | `this`, args, return values, async siblings, original errors, Lua nil/multiple returns, корутины/creator parent, tail calls и native child exit/signal | regression fixtures, owner native/browser suites, Java comparisons |
| Выходные данные | Учебный текст, ответы, ссылки, значения и ZIP entries остаются значимыми; source-root normalization ограничена явно заданным корнем; duplicate attrs и script/style/comments не переписываются | negative comparator tests, QRC TS/Lua fixtures, 10 сравнений и repeat |
| Владение нормализацией | QRC задаёт порядок своих attrs в native Attr и финализации HTML; Performance использует ту же функцию из immutable Git blob, сохраняет SHA/hash receipt; dirty checkout не исполняется | QRC metadata-order fixtures, immutable owner-normalizer fixture |
| Контекст | AsyncLocalStorage в TS; отдельные Lua stacks/coroutines; подтверждённые process/span edges через native command boundaries; отсутствующие parent edges не угадываются | async/coroutine/tail-error/boundary fixtures, causal.json |
| Часы | TS monotonic wall с epoch calibration и uncertainty; Lua process CPU пикосекунды переводятся в микросекунды до арифметики; шкалы не совмещаются | clock fixtures, separate Perfetto traces/processor |
| Покрытие | 224 ручные semantic операции, явные full/fragment/block/inline/unknown walks; summary/cpu не пишут поузловые handlers; selected TS/Lua trace показывает unsupported/skipped и strict отказ | ABI/registry audit, coverage.json, synthetic scaling |
| Качество | Build exit и data validity независимы; dropped/incomplete/protocol/ABI/errors делают диагностические данные невалидными; raw failed evidence сохраняется | normalizer/error/signal fixtures, quality.json, ранние invalid runs |
| Benchmark и ресурсы | Hyperfine запускает обычный argv без profiler/supervisor внутри интервала; отдельный GNU time сохраняет status исходного инструмента, resource scope включает supervisor | native Hyperfine/signal fixtures, прежние paired raw series |
| Границы поставки | Только owner bridge и разметка в installable packages; backend/runtime patches и события остаются в Performance; нет merge, Release или публикации курса | package audit, leak/ZIP scan, шесть draft PR |

`coverage.complete` относится к объявленному scope. Ненаблюдавшаяся Navigation
не считается нулём вызовов. `node_visits` и async self time недоступны;
inclusive времена не суммируются как длительность сборки, CPU samples не
выдаются за точные call counts. Специальный Lua sampling backend недоступен;
штатная Lua call/return trace работает. Подтверждённый устранимый bottleneck
не выявлен; ускорение курса не заявляется.
