# Пилот Java: состояние проверки

Проверка ещё продолжается. Этот документ сопровождает draft PR; он не подтверждает завершение acceptance по накладным расходам.

Эксперимент `2ffddcf0-7c16-48a8-901a-e93051db476a` использует согласованный Java PR13 SHA `a0d1bdb9d8343809560e3ce7f9a2141d4473ee3f`. GitHub refs получены на старте 12 октября 2026 года; внутри эксперимента они не обновляются. [Закреплённые inputs](evidence/java-pilot-inputs.json) содержат candidate SHA и runtime hashes; пути заменены переносимыми обозначениями. Полные raw данные и installed-package receipts сохранены в локальном workspace `performance-20261012/acceptance-v3`.

## Функциональные и диагностические проверки

- Полные student/full summary: build exit 0, данные валидны, по 405 summaries без dropped events и incomplete spans. Установлены семь пакетов; наблюдались операции шести, `course-navigation` — `not-observed` в этом scope.
- Выбранные TS и Lua trace, TS V8 CPU profile, отдельный PL export в off/summary: build exit 0, данные валидны. Runtime registry закреплён на PrairieLearn Platform v2.0.0 (`b971a61a2386fbf4ae7fcfc9394d307359bc7889`). Проверка не запускает grading или публикацию.
- Performance: 54 tests, typecheck и fmt проходят. Native fixtures проверяют off identity, values/this/ошибки, async siblings, Lua nil returns, корутины, tail calls, signal/exit, clocks, manifests, outputs, launchers и качество данных. Дополнительные Lua regression fixtures сначала воспроизвели потерю parent/error, после исправления проходят.
- Owner checks: Core native и browser; QRC native, HTTP и browser; Publisher native; Download install/native; PrairieLearn 49 unit, native и Java demo прошли. Publisher resources fixture проверен с его CI-pinned Core v4; интеграционный Java использует актуальный Core v6. Это разные contract checks.
- ABI audit: одинаковый ABI 1 в семи packages, 224 зарегистрированные операции; внутренние agents/launchers отсутствуют в распространяемых packages.
- Synthetic Core scaling 1/2/4 exercises: full walks 27/27/27, fragment walks 93/120/174; off и summary outputs эквивалентны. Наблюдение не доказывает избыточность обходов.
- Официальный Perfetto v58.2 trace processor и UI открыли wall и Lua CPU traces раздельно. UI проверен из локальной копии официального distribution, поскольку внешний UI был недоступен.

Полные outputs для upstream/control/candidate и повторная сборка проверяются дополнительно после завершения парных benchmark. После последних исправлений внутреннего Lua backend выбранные диагностики будут повторены. Старые snapshots backend сохранены с hashes каждого run.

## Накладные расходы off

Hyperfine 2.0.0; warmup каждого варианта исключён, затем AB/BA. Медиана парных ratios candidate/control, 95% bootstrap interval, 10 000 resamples, seed 42; нормативный предел 1.01.

| Сценарий | Пар | Медиана | 95% interval | Статус |
| --- | ---: | ---: | --- | --- |
| [AST document](evidence/java-ast-document.json) | 10 | 0.994389 | [0.986123, 1.010682] | INCONCLUSIVE |
| [TS publication](evidence/java-ts-publication.json) | 10 | 1.002249 | [0.982565, 1.023245] | INCONCLUSIVE |
| full student | 5 запланировано | — | — | выполняется |
| full full | 5 запланировано | — | — | ожидает |

Точечные оценки не подтверждают предел 1%. Короткие сценарии будут повторены с 30 парами; первоначальные raw результаты сохраняются. Полные benchmark выполняются последовательно. Кеш ОС не очищается, governor и пользовательские процессы не изменяются. Во время замеров допускаются редактирование текста и короткие regression fixtures; тяжёлые suite/browser/диагностические сборки параллельно не запускаются. Замеры характеризуют эту машину и это состояние кешей.

## Ограничения и рецензия

Самопроверка выполнена тем же implementer; независимая рецензия не заявляется. Проверка охватывает ABI/off, module scope, Lua error unwinding, clocks, process boundaries, package distribution и качество данных. Итоговая матрица R-01–R-18 и ссылки на PR будут дополнены фактическими результатами оставшихся проверок.

Подробная трассировка относится только к выбранному поддерживаемому scope. Lua CPU и TS wall не совмещаются, inclusive времена не суммируются. `node_visits` недоступен; callback counts не заменяют его. Подтверждённый устранимый bottleneck пока не выявлен; отчёт не заявляет ускорение курса.

## Связанные PR

- [quarto-course-performance](https://github.com/Afonenko-Course-Tools/quarto-course-performance/pull/1) — OPEN draft.
- [quarto-course](https://github.com/Afonenko-Course-Tools/quarto-course/pull/33) — OPEN draft.
- [quarto-project-publish](https://github.com/Afonenko-Course-Tools/quarto-project-publish/pull/12) — OPEN draft.
- [quarto-reference-catalog](https://github.com/Afonenko-Course-Tools/quarto-reference-catalog/pull/17) — OPEN draft.
- [quarto-project-download](https://github.com/Afonenko-Course-Tools/quarto-project-download/pull/9) — OPEN draft.
- [quarto-course-prairielearn](https://github.com/Afonenko-Course-Tools/quarto-course-prairielearn/pull/17) — OPEN draft.

Performance, Core, QRC, Download и PrairieLearn GitHub checks прошли; Publisher check ещё выполняется. Первая Performance CI выявила отличие native signal status GNU time между локальной машиной и GitHub runner. Runner теперь сохраняет status исходного инструмента отдельным внешним помощником; Hyperfine benchmark не использует помощник. Повторная CI прошла; итоговый локальный набор после уточнения summary содержит 54 tests.

При самопроверке дополнительно отключена поузловая запись filter handlers в summary/cpu; document phases и shortcode boundaries сохраняются. Первые protocol-valid summaries с более широкой ручной записью сохранены как предыдущая версия backend. Финальные summary будут повторены с явной observationPolicy в coverage.
