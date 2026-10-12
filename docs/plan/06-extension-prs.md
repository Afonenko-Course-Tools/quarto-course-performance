# Совместная разработка и PR расширений

Основание: [архитектура](02-architecture.md), [источники](04-sources-and-java-pilot.md), [план](05-implementation-plan.md).

## Принцип

Проект Performance владеет протоколом, шаблонами фасада, агентами, runner, преобразователем и аналитикой. Репозитории расширений владеют своим поведением, точками разметки, помощниками обходов и упаковкой фасада. Семантическая логика курса не переносится в профилировщик.

Разрешены серьёзные внутренние рефакторинги и замена старой телеметрии. Публичное функциональное поведение, смысл учебных материалов и installability должны быть проверены. Новую библиотеку не превращать в общий business runtime или обязательное ещё одно Quarto-расширение.

## Предварительный состав PR

Ниже пути, наблюдавшиеся при подготовке. После fresh GitHub discovery подтвердить их и записать финальные пути в source inventory. Новые фасады создаются в `_extensions/<extension>/observability/bridge.ts` и/или `bridge.lua`.

| Owner | Изменения | Доказательства |
| --- | --- | --- |
| `quarto-course` | Core: сбор педагогики, фильтры, явные AST walks, pre/post/export и command boundaries. Presentation: основные преобразования/обходы. Navigation: Lua shortcode/TS операции, если входят в сценарий. | Полные student/full, реальные ответы/задания, presentation/navigation проверки, exact walks fixtures |
| `quarto-project-publish` | course-site pre/post/collect, orchestration дочерних render/inspect, копирование/подготовка результатов. Заменить старые timing/trace internals. | Полная карта процессов, сохранённые argv/cwd/outputs/errors, owner process/profile tests |
| `quarto-reference-catalog` | publish/linker/HTML parsing/catalog IO и Lua callbacks; замена прежнего `COURSE_BUILD_TRACE`. | Каталог и ссылки совпадают, сохранены partial-output contracts, async контекст, обновлены legacy telemetry tests |
| `quarto-project-download` | inventory/hash/ZIP/publish и инфраструктурный command boundary, Lua/shortcode операции по фактическому использованию. | Совпадение состава и содержимого ZIP, отсутствие дополнительных архивов/файлов метрик в outputs |
| `quarto-course-prairielearn` | Реально используемые export операции и фильтры. Не добавлять измеряемый экспорт в обычный render искусственно. | Export contract tests и отдельный сценарий, если экспорт подключён |

Java integration PR нужен только при необходимых изменениях конфигурации/официальных package references. Для установки ещё не выпущенных owner commits в измерительную рабочую копию не нужен фиктивный PR с внутренними агентами в Java.

## Последовательность коммитов и координация

1. В Performance согласовать ABI 1, off-path fixtures и distribution templates.
2. В каждом owner выделить чистые внутренние изменения и удаление прежней телеметрии; записать контрольный `clean-control` commit.
3. Добавить точки разметки и локальный фасад отдельным коммитом. Сравнивать overhead с чистым control, а функциональные outputs — также с upstream.
4. Собрать единый Java candidate из всех нужных owner commit SHA. Индивидуальные PR остаются installable без установки Performance.
5. При изменении ABI сначала обновить контракт и conformance fixtures, затем все затронутые копии. Не мигрировать ABI частично в одном измеряемом варианте.
6. Провести cross-repository integration review; исправить код, тесты, current spec и README одновременно.

Старый `COURSE_BUILD_TRACE` не сохраняется обязательным совместимым режимом. Проверить реальные внешние потребители и документировать удаление, если контракт был публичным. Замена только внутреннего test helper не требует отдельного пользовательского механизма миграции.

## Содержимое финальной передачи

Для каждого изменённого owner: OPEN draft PR или готовый reviewable PR, краткое русское описание проблемы и поведения, проверенные команды, ссылки на общий Java integration experiment, off overhead status, ограничения coverage и package receipt. Если нужен новый GitHub owner Performance, его создание/видимость отдельно зафиксировать при реализации; архив не создаёт его автоматически.

Тело PR передавать структурированно либо через `--body-file`, сохраняя реальные переводы строк. Проверить текущие GitHub PR templates. Не добавлять внутренние абсолютные пути/агенты в пакет расширения.

Merge, выпуск релизов, публикация gh-pages/курса и очистка пользовательских или remote веток в этот план не входят. Не переносить эти действия из исторического AGENTS или старых проектов как текущую цель.
