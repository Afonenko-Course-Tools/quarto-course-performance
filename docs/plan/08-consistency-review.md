# Рецензия согласованности требований и плана

Дата: 12 октября 2026 года. Выполнена авторская рецензия документов после составления требований и задач. Это self-review, а не независимая рецензия другого агента и не проверка ещё не написанной реализации.

## Итог

После учёта последних уточнений пользователя и исправлений ниже **блокирующих противоречий в пакете не обнаружено**. Вопрос часов Lua разрешён: временные данные Lua и TS на первом этапе раздельны. План не привязан к текущему local checkout, branch или SHA.

Работоспособность реализации, совместимость будущих GitHub tips и фактические накладные расходы пока не подтверждены. Для этого существуют задачи и критерии, а не заранее проставленные PASS.

## Обнаруженные расхождения и исправления

| ID | Расхождение | Исправление и состояние |
| --- | --- | --- |
| F-01 | Общая временная шкала предполагала сопоставимость Lua CPU и TS wall clocks | Решение пользователя D-07: раздельные представления. Убраны общий wall clock Lua и его зависимости. Закрыто. |
| F-02 | Прежнее предложение использовало найденную локальную JavaPR и SHA владельцев | R-01/D-03 и T-01: fresh GitHub discovery при реализации, затем immutable experiment. Локальные версии не нормативны. Закрыто. |
| F-03 | Совместимость со старой COURSE_BUILD_TRACE могла навязать legacy architecture | D-04/T-05: чистая замена внутренних механизмов; проверяются реальные функциональные контракты и потребители. Обязательный legacy adapter исключён. Закрыто. |
| F-04 | Runner benchmark возвращал итоговую статистику до задачи аналитики | T-06 возвращает BenchmarkSeries с raw pairs; T-07 владеет BenchmarkComparison. Цикл зависимостей устранён. Закрыто. |
| F-05 | Source SHA/package hash не различал временный bootstrap/transform | Добавлен PreparationReceipt, отдельные before/after hashes и source mapping в run metadata. Измерительная копия не выдаётся за оригинал. Закрыто. |
| F-06 | Удаление старых таймеров могло скрыть overhead нового фасада | clean-control сохраняется после cleanup и до разметки; R-16/T-10 сравнивают именно control и candidate/off. Закрыто. |
| F-07 | «Полная карта» могла означать все native внутренности, а малая разметка — только exports | R-08: точные наблюдаемые вызовы в объявленном scope; глобальная карта процессов/этапов. T-08 strict preflight/coverage, отсутствие наблюдения не равно 0. Закрыто. |
| F-08 | Обычная сборка могла загрузить внутренний SDK runtime и получить async startup | Маленький фасад синхронен и самодостаточен; внутренний bootstrap только в diagnostic copies. T-02/T-03 проверяют identity/import.meta.main. Закрыто. |
| F-09 | Peak RSS и сумма inclusive длительностей могли быть названы суммарными ресурсами | R-11/[07](07-validation.md): точные подписи метрик, отсутствие сложения parent/child/overlapping интервальных затрат. Закрыто. |
| F-10 | Старые owner задачи на Releases/публикацию/cleanup могли автоматически перейти в scope | [06](06-extension-prs.md)/[10](10-codex-handoff.md): reviewable PR входят; merge, релизы, deploy и очистка unrelated веток не входят. Закрыто. |

## Матрица требований

| Требование | Задачи | Основная проверка |
| --- | --- | --- |
| R-01 GitHub и фиксация входов | T-01 | resolve remote tip/frozen manifest |
| R-02 Изоляция | T-01/T-06 | unsafe destination/symlink и сохранение user checkout |
| R-03 Сборка целиком | T-05/T-06/T-10 | full student/full, nested process map, отдельные exports |
| R-04 Off без диагностики | T-02/T-03/T-04/T-06 | function/env identity, no hooks/import/timers/logs |
| R-05 Самодостаточные пакеты | T-02/T-05/T-11 | package audit и ABI drift |
| R-06 Сохранение результатов | T-03/T-04/T-05/T-07/T-10 | differential fixtures и actual Java outputs |
| R-07 Ручная разметка | T-05 | operation registry, source readability, owner tests |
| R-08 Function trace scope | T-04/T-08/T-09 | strict coverage и differential transform tests |
| R-09 AST показатели | T-04/T-05/T-09 | nested/fragment fixtures, filter without traversal |
| R-10 Контекст | T-03/T-04/T-06 | Promise.all, recursion, coroutine, child env |
| R-11 Clocks | T-04/T-07/T-10 | lua_cpu_never_enters_wall_trace, clock labels |
| R-12 Ordinary benchmark | T-06/T-10 | off env, standard binary, AB/BA and raw pairs |
| R-13 Evidence и outputs | T-01/T-06/T-07/T-10 | manifests, preparation hashes, profiles, reports |
| R-14 Качество данных | T-03/T-04/T-07/T-09 | exits, malformed JSONL, lost events, partial backend |
| R-15 Проект и PR | T-05/T-10/T-11 | coherent package set, owner checks, Java integration |
| R-16 Off overhead | T-06/T-07/T-10 | clean-control/candidate ratio, interval/status |
| R-17 Русские тексты | T-05/T-10/T-11 | README/spec/report/PR editorial review |
| R-18 Локальное измерение после discovery | T-01/T-06/T-10 | frozen workspace, preparation outside timer |

## Проверка интерфейсов и последовательности

- Mode/Variant/Scenario и raw Event определены один раз в контрактах и используются задачами без конфликтующих enum values.
- camelCase внутренних TypeScript types и snake_case raw Event явно разделены; глобальное переименование полей не используется.
- SourceReceipt различает GitHub baseline и локальный candidate с baseSha; candidate не выдаётся за исходник, уже существовавший на GitHub в момент discovery.
- RunResult содержит preparation receipts. Original package hash и подготовленные файлы различаются.
- Runner производит raw BenchmarkSeries; analyst вычисляет Comparison. T-06 не требует реализации T-07 для сбора данных.
- T-03/T-04 можно проверить на fixtures до интеграции владельцев; T-05 normal builds не требует ещё не готового runner.
- T-08/T-09 входят в обязательный путь пилота, а не скрыто исчезают после summary. Lua sampler при недоступности честно обозначается unavailable.
- Optional export scenario не включается в ordinary render искусственно. Source discovery определяет actual подключённые пакеты.
- No data не превращается в 0; CI/benchmark FAIL/INCONCLUSIVE не превращается в успешную передачу.

## Риски реализации, не противоречия документов

1. Fresh GitHub default branches могут ещё не содержать ожидаемую Java или быть несовместимыми. Это проверяется в T-01; explicit ref согласовывается при реальном расхождении.
2. Off overhead ≤ 1% — проверяемая цель, а не гарантия. Длительные/шумные измерения могут закончиться INCONCLUSIVE.
3. Универсальный TS transformer сложен. Пилот проверяет объявленный scope; для unsupported конструкции strict full request не выдаёт ложную полноту.
4. Hooks и wrappers искажают численные длительности подробного trace. В speed comparison используется только ordinary benchmark.
5. Lua CPU clock отражает CPU процесса и имеет ограниченную точность; это не wall и не гарантированная собственная CPU стоимость функции.

Все эти риски имеют тесты, evidence и условия честной передачи. Новое существенное расхождение при реализации требует отдельного обсуждения, но сейчас повторно открывать уже решённые вопросы не нужно.

## Проверка документов

После рецензии выполнена структурная проверка: относительные ссылки разрешаются внутри пакета, Markdown code fences сбалансированы, нет незаполненных TODO/TBD или зафиксированных текущих local paths/SHA, требования R-01—R-18 покрыты матрицей, задачи T-01—T-11 имеют последовательные ID. Отдельно проверены возвращаемые типы BenchmarkSeries и PreparationReceipt и наличие теста разделения clock domains.

Это проверка передаваемых документов. Она не означает, что будущие команды, agents, owner PR или проверки Java уже реализованы/выполнены.
