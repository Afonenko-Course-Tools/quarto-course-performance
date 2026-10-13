# Пилот Java: состояние проверки

Функциональная проверка завершена на исправленных QRC/Core. Все 13 сборок успешны, шесть диагностических запусков валидны; итоговый `verify` завершился с кодом 0. Пользователь 13 октября 2026 года отложил рассмотрение R-16: дополнительные замеры накладных расходов не выполняются, предел ≤1% не объявляется подтверждённым.

Финальный функциональный эксперимент `520f454c-bb6a-4f79-bd7b-4d781f7f4d04` использует согласованный Java PR13 SHA `a0d1bdb9d8343809560e3ce7f9a2141d4473ee3f`. GitHub refs получены на старте 12 октября 2026 года; внутри эксперимента они не обновляются. [Закреплённые inputs](evidence/java-pilot-inputs.json) содержат candidate SHA и runtime hashes; пути заменены переносимыми обозначениями. Полные raw данные сохранены в `/home/tolya/course-tools/performance-20261012/acceptance-v4`; прежний benchmark — в `acceptance-v3`. [Installed-package и artifact receipts](evidence/java-pilot-packages.json) содержат SHA/hash каждой версии и пути всех установленных копий.

## Функциональные и диагностические проверки

- Полные student/full summary: build exit 0, данные валидны, по 405 summaries без dropped events и incomplete spans. Установлены семь пакетов; наблюдались операции шести, `course-navigation` — `not-observed` в этом scope.
- Выбранные TS и Lua trace, TS V8 CPU profile, отдельный PL export в off/summary: build exit 0, данные валидны. [Все 13 сборок](evidence/java-pilot-builds.json), [quality](evidence/java-pilot-quality.json) и [coverage](evidence/java-pilot-coverage.json) доступны отдельно. Runtime registry закреплён на PrairieLearn Platform v2.0.0 (`b971a61a2386fbf4ae7fcfc9394d307359bc7889`). Проверка не запускает grading или публикацию.
- Performance: 58 tests, typecheck и fmt проходят. Native fixtures проверяют off identity, values/this/ошибки, async siblings, Lua nil returns, корутины, tail calls, signal/exit, clocks, manifests, outputs, launchers и качество данных. Дополнительные Lua regression fixtures сначала воспроизвели потерю parent/error, после исправления проходят.
- Owner checks: Core native и browser; QRC native, HTTP и browser; Publisher native; Download install/native; PrairieLearn 49 unit, native и Java demo прошли. Publisher resources fixture проверен с его CI-pinned Core v4; интеграционный Java использует актуальный Core v6. Это разные contract checks.
- ABI audit: одинаковый ABI 1 в семи packages, 224 зарегистрированные операции; внутренние agents/launchers отсутствуют в распространяемых packages.
- Synthetic Core scaling 1/2/4 exercises: full walks 27/27/27, fragment walks 93/120/174; off и summary outputs эквивалентны. Наблюдение не доказывает избыточность обходов.
- Официальный Perfetto v58.2 trace processor открыл финальные wall и Lua CPU traces раздельно: 81 slice/4 tracks и 9804 slices/1 track. UI ранее проверен на v3 из локальной копии официального distribution, поскольку внешний UI был недоступен.

Сохранённые outputs исходного эксперимента проверены: [10 сравнений](evidence/java-pilot-outputs-v3.json) upstream/control/candidate/summary, выбранные off/trace/cpu и PrairieLearn эквивалентны; утечек внутренних profiles/events в outputs и ZIP нет. [Два повторных student render](evidence/java-pilot-repeat-v3.json) также эквивалентны. Первоначальный строгий отказ на 118 HTML сохранён: исследование всех файлов показало только перестановку metadata attrs, без изменения значений, дерева и учебного текста.

По указанию пользователя исправление выполнено у владельца: QRC `5868fa0` создаёт отсортированные пары для native Pandoc Attr и канонизирует собственные metadata в обычной HTML-финализации. Эта же чистая функция из закреплённого Git blob используется для сравнения исторических outputs, с SHA/hash receipt; её копии в Performance нет. Только явно переданный корень временной копии заменяется в QRC source attr, относительный путь сохраняется. Core `5daaa4f` добавляет defaults в фиксированном порядке полей. Повторные полные QRC и Core native/browser suites прошли; новые регрессии проверены до/после исправления.

Финальный функциональный эксперимент `520f454c-bb6a-4f79-bd7b-4d781f7f4d04` — отдельный workspace `performance-20261012/acceptance-v4`. Upstream и clean-control SHAs прежние; Java/workload/runtime не изменены. Полные off/summary, выбранные trace/CPU и экспорт на исправленных owners завершены успешно. [10 итоговых сравнений](evidence/java-pilot-outputs-validation.json) эквивалентны, утечек нет; [повторная сборка](evidence/java-pilot-repeat-validation.json) эквивалентна во всех шести каталогах. Дополнительно [281 HTML-файл совпадает побайтово без нормализации](evidence/java-pilot-repeat-html-bytes.json). Предыдущие данные не переписываются и не выдаются за измерение новой версии.

## Накладные расходы off — отложенный критерий

Hyperfine 2.0.0; warmup каждого варианта исключён, затем AB/BA. Медиана парных ratios candidate/control, 95% bootstrap interval, 10 000 resamples, seed 42; нормативный предел 1.01.

| Сценарий | Пар | Медиана | 95% interval | Статус |
| --- | ---: | ---: | --- | --- |
| [AST document](evidence/java-ast-document.json) | 30 | 1.006806 | [0.996078, 1.023429] | INCONCLUSIVE |
| [TS publication](evidence/java-ts-publication.json) | 30 | 1.012307 | [0.999395, 1.028167] | INCONCLUSIVE |
| [full student](evidence/java-full-student.json) | 5 | 1.006641 | [1.000327, 1.035261] | INCONCLUSIVE |
| [full full](evidence/java-full-full.json) | 5 | 1.022257 | [1.004895, 1.069694] | INCONCLUSIVE |

Эта таблица относится к прежнему эксперименту `2ffddcf0-7c16-48a8-901a-e93051db476a` с [отдельными inputs](evidence/java-pilot-benchmark-inputs.json), до исправления порядка attrs. Точечные оценки не подтверждают предел 1%. По текущему решению пользователя вопрос отложен; повторных benchmark для новых ревизий не выполнялось. Короткие сценарии повторены с 30 парами, полные — с 5 парами каждый; первоначальные 10-парные raw результаты сохранены. Полные benchmark выполнялись последовательно. Кеш ОС не очищается, governor и пользовательские процессы не изменяются. Во время замеров допускаются редактирование текста и короткие regression fixtures; тяжёлые suite/browser/диагностические сборки параллельно не запускаются. Замеры характеризуют эту машину и это состояние кешей.

## Ограничения и рецензия

Самопроверка выполнена тем же implementer; независимая рецензия не заявляется. Проверка охватывает ABI/off, module scope, Lua error unwinding, clocks, process boundaries, package distribution и качество данных. Итоговая [матрица R-01–R-18](requirements-status.md) и [самопроверка](self-review.md) фиксируют доказательства и ограничения. T-01–T-09 и функциональная часть T-10 завершены; T-11 завершён: PR, отчёт, доказательства и ограничения подготовлены. Из первоначальных критериев отложен только R-16.

Подробная трассировка относится только к выбранному поддерживаемому scope. Lua CPU и TS wall не совмещаются, inclusive времена не суммируются. `node_visits` недоступен; callback counts не заменяют его. Подтверждённый устранимый bottleneck пока не выявлен; отчёт не заявляет ускорение курса.

## Связанные PR

- [quarto-course-performance](https://github.com/Afonenko-Course-Tools/quarto-course-performance/pull/1) — OPEN draft.
- [quarto-course](https://github.com/Afonenko-Course-Tools/quarto-course/pull/33) — OPEN draft.
- [quarto-project-publish](https://github.com/Afonenko-Course-Tools/quarto-project-publish/pull/12) — OPEN draft.
- [quarto-reference-catalog](https://github.com/Afonenko-Course-Tools/quarto-reference-catalog/pull/17) — OPEN draft.
- [quarto-project-download](https://github.com/Afonenko-Course-Tools/quarto-project-download/pull/9) — OPEN draft.
- [quarto-course-prairielearn](https://github.com/Afonenko-Course-Tools/quarto-course-prairielearn/pull/17) — OPEN draft.

GitHub checks всех шести draft PR прошли. Первая Performance CI выявила отличие native signal status GNU time между локальной машиной и GitHub runner. Runner теперь сохраняет status исходного инструмента отдельным внешним помощником; Hyperfine benchmark не использует помощник. Повторная CI прошла; итоговый локальный набор после уточнения summary содержит 58 tests.

При самопроверке отключена поузловая запись filter handlers в summary/cpu; document phases и shortcode boundaries сохраняются. Первые protocol-valid summaries с более широкой ручной записью сохранены как предыдущая версия backend. Последние summary повторены с явной observationPolicy в coverage.
