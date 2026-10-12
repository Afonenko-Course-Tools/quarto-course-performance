# Исходники и пилот на Java

Связанные документы: [требования](01-requirements.md), [план](05-implementation-plan.md), [проверки](07-validation.md).

## Источник на момент реализации

Нормативное правило — **получить актуальное состояние из GitHub при начале реализации**. После получения записать SHA и установить immutable источник для эксперимента. План не фиксирует дату, local path, текущую ветку JavaPR или найденный в ходе подготовки SHA.

Известные repository identities:

| Роль | GitHub |
| --- | --- |
| Java | [BSU-RFCT-Afonenko-Courses/Java](https://github.com/BSU-RFCT-Afonenko-Courses/Java) |
| Core, Presentation, Navigation | [Afonenko-Course-Tools/quarto-course](https://github.com/Afonenko-Course-Tools/quarto-course) |
| Сборка и публикационная подготовка сайта | [Afonenko-Course-Tools/quarto-project-publish](https://github.com/Afonenko-Course-Tools/quarto-project-publish) |
| Reference Catalog | [Afonenko-Course-Tools/quarto-reference-catalog](https://github.com/Afonenko-Course-Tools/quarto-reference-catalog) |
| Project Download | [Afonenko-Course-Tools/quarto-project-download](https://github.com/Afonenko-Course-Tools/quarto-project-download) |
| PrairieLearn | [Afonenko-Course-Tools/quarto-course-prairielearn](https://github.com/Afonenko-Course-Tools/quarto-course-prairielearn) |

Этот список начальный. Обнаружение актуальной конфигурации Java обязательно: если подключены другие владельцы, добавить их к манифесту, охвату и PR-плану. Не подключённые расширения не включать искусственно ради полноты списка.

## Политика выбора refs

1. Для каждого repository запросить удалённую default branch и её tip; не предполагать `main` или `master`.
2. Получить ветку из GitHub и записать полный SHA, remote ref, время получения и owner. Проверить соответствие checkout этому SHA.
3. Если свежая Java содержит учебную ревизию только в открытом PR, а default branch ещё не является ожидаемым актуальным курсом, предъявить это расхождение пользователю и получить explicit remote ref. Не выбирать «самую новую ветку» по дате коммита.
4. Исходники расширений в пилоте — свежие default branch tips владельцев, а не обязательно последний tag/release. Версии `_extension.yml` записываются отдельно от SHA.
5. Не обновлять refs между вариантами одного эксперимента. Повторный discovery создаёт новый experiment и новые baseline.

Пилот измеряется локально на Linux x86-64, но локальная копия — рабочий checkout полученных из GitHub исходников. Пользовательские `/home/...` каталоги не используются как канонический источник и не очищаются.

## Предварительные проверки

- Прочитать актуальные `AGENTS.md`, current spec indexes, release/packaging contracts и PR templates владельцев.
- Зафиксировать installed Quarto, его bundled Deno, Pandoc, Lua и Hyperfine, пути и hash. Не подменять bundled Deno системным только потому, что он новее.
- Выполнить capabilities probe для AsyncLocalStorage, CPU flags, data-dir/init.lua и необходимых API. Версии, найденные 12 октября при подготовке документов, не являются вечным pin или гарантией совместимости.
- Получить всю цепочку runtime данных локально до benchmark: шрифты, dependencies, библиографию и другие реально требуемые ресурсы.
- Сначала собрать upstream Java с актуальными owner packages. Несовместимость fresh owner contracts и курса документировать; не переходить к измерению сломанного baseline.

## Установка пакетов и варианты

В измеряемых копиях курс не использует случайно оставшиеся vendored старые расширения. Packager берёт installable содержимое из зафиксированного owner checkout и записывает owner SHA/package hash для каждой destination copy. Вариант `candidate` использует изменения owner PR, зафиксированные локальными commit SHA; отсутствие published release нормально для пилота.

Нельзя накладывать новые пакеты только в корень курса. Проверить корневой портал, lectures, practice, handbook, theory и tasks либо их актуальные имена. Динамические импорты sibling-пакетов должны разрешаться к согласованному набору пакетов одного варианта.

Подготовка рабочих копий, установка, bootstrap imports, compilation и сборка профилировщика происходят **вне** измеряемого интервала. Каждая измеряемая попытка получает независимые outputs либо восстановленное одинаковое состояние по cache policy.

## Обязательные сценарии

| ID | Рабочий каталог / команда | Назначение |
| --- | --- | --- |
| `java-full-student` | корень курса; `quarto render --profile student` | Полная обычная сборка с дочерними проектами |
| `java-full-full` | корень курса; `quarto render --profile full` | Полный преподавательский профиль |
| `java-repeat-student` | та же корневая команда, repeat-render | Повторная сборка без удаления outputs |
| `java-ast-document` | относительный документ из tasks/practice; `quarto render <document> --profile student` | Фильтры, вложенные обходы и исключаемые поддеревья |
| `java-ts-publication` | тот subproject, который запускает QRC post-render; штатный render | Каталог, HTML linking и подготовка результатов |

Конкретные document paths выбираются при discovery и записываются в scenarios: один документ с заданиями/ответами, один с nested педагогическими блоками и один с активными ссылками каталога. Если таких документов нет, заменить их реальным эквивалентом, а synthetic fixtures держать отдельно от материалов курса. Команда отдельного документа не считается полной сборкой портала.

Дополнительный `java-prairielearn-export` создаётся, если актуальная Java действительно использует соответствующий exporter. Команда берётся из действующего контракта владельца и записывается в манифест. Render не объявляется измерением всех экспортов. Никакой публикации в production, сетевого deploy или автоматического выполнения удалённого grading в сценарии измерения.

## Контроль рабочей нагрузки

Записывать число обработанных документов/outputs, профиль, существенные счётчики и выбранный scope. При сравнении содержимое курса одинаково. Нормализованные показатели `walks/document`, `calls/document`, `parses/output` дополняют абсолютные времена, но не заменяют сравнение одного workload.

Проверки масштабирования для повторной работы выполняются на synthetic fixtures 1×/2×/4× в проекте Performance. Не менять реальные учебные материалы ради генерации нагрузки.
