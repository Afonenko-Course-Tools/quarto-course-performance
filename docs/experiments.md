# Изолированные эксперименты и сравнение

Для повседневного измерения достаточно [простого `render`](diagnostics.md). Команды
`quarto-course-perf experiment` нужны, когда необходимо закрепить исходники, сравнить варианты,
трассировать выбранные функции в отдельной копии. Они используют конфигурацию v2 и не привязаны к
имени Java.

## Конфигурация v2

Создайте JSON-файл для своего репозитория. Следующий пример показывает форму данных; замените
`example/course` и цель существующими значениями своего курса:

```json
{
  "schema_version": 2,
  "projectSource": "example/course",
  "outputPolicy": "strict",
  "scenarios": [
    {
      "id": "render-page",
      "cwd": ".",
      "executable": "quarto",
      "args": ["render", "index.qmd"],
      "cachePolicy": "clean-output",
      "mode": "off",
      "scope": { "modules": [], "extensions": [], "strict": true },
      "resources": { "wall": true, "cpu": true, "peakRss": true }
    }
  ],
  "cleanPaths": ["_site"],
  "benchmark": { "pairs": 10, "maxSlowdownRatio": 1.01 }
}
```

`projectSource` — идентификатор курса в evidence, без удалённого ref или SHA. В `args` находится
полная команда Quarto после имени executable, включая `render` либо `run`. Рабочий каталог сценария
задаётся относительно копии проекта. Поля прежнего пилота `project` и `courseProfile` не
принимаются; профиль передаётся обычными аргументами `--profile`.

Проверьте `cleanPaths` по своему проекту: очищаются только перечисленные пути подготовленной копии.
`clean-output` и `repeat-render` описывают разные политики повторного использования результатов.
Параметры `{course_root}`, `{run_output}` и `{runtime_registry}` подставляются внутри argv без shell
evaluation. Внешний registry задаётся только сценарию, который в нём нуждается.

Точные структуры и валидация находятся в [`src/config/types.ts`](../src/config/types.ts) и
[`src/config/validate.ts`](../src/config/validate.ts). `outputPolicy` по умолчанию равна `strict`.
Именованная `java-pilot-core-qrc-v1` сохраняет совместимость конкретной методики пилота и не
является общим разрешением нормализовать HTML любого курса.

## Подготовка и фиксация источников

Performance не получает исходники и не устанавливает расширения. Выберите версии обычным Git
checkout/worktree или submodules; установите расширения штатной командой Quarto в каждый нужный
корневой и вложенный проект. Например, в новом проекте с единым плоским layout:

```sh
cd /absolute/candidate/course
quarto add /absolute/checkouts/quarto-course --no-prompt
quarto add /absolute/checkouts/quarto-reference-catalog --no-prompt
```

Локальный `quarto add` устанавливает весь bundle репозитория плоско в `_extensions`; GitHub install
использует namespace владельца. Для нового варианта выбирайте согласованный layout: добавление
локального bundle поверх прежних namespaced копий создаёт два пакета одного имени. Подготовьте
свежий проект с нужными bundles либо используйте стандартную установку GitHub для всех пакетов.
Установка Core включает все расширения его bundle, а не один выбранный файл. Сохраните готовые
установленные пакеты обычными файлами коммита курса. Внешние source submodules подготовьте через
`git submodule update --init --recursive` перед `quarto add`; сам archive курса их содержимое не
включает. Не добавляйте отдельную матрицу версий Performance.

Для фиксации трёх вариантов подготовьте чистые checkout/worktree каждого источника и файл inputs:

```json
{
  "projectSource": "example/course",
  "variants": {
    "upstream": "/absolute/upstream/course",
    "clean-control": "/absolute/control/course",
    "candidate": "/absolute/candidate/course"
  }
}
```

Каждый путь указывает на целый готовый Git checkout курса с установленными расширениями. Разные
варианты используют содержимое соответствующих деревьев; если содержимое одинаково, допускается один
путь. `freeze` автоматически записывает фактические HEAD, ref, пути и runtime versions, проверяет
чистоту и создаёт общий идентификатор эксперимента. Ручных SHA во входах нет. Файлы
`*.manifest.json` — evidence конкретного эксперимента; обычный `render` их не читает. Существующий
эксперимент не перезаписывается. После изменения входов создайте новый workspace.

```sh
quarto-course-perf experiment freeze --config /absolute/perf.json --workspace /absolute/experiment --inputs /absolute/inputs.json
quarto-course-perf experiment run --config /absolute/perf.json --workspace /absolute/experiment --scenario render-page --variant candidate --mode off
quarto-course-perf experiment report --workspace /absolute/experiment
quarto-course-perf experiment verify --workspace /absolute/experiment
```

`run` каждый раз экспортирует соответствующий commit курса штатным `git archive` и распаковывает его
через `tar` в отдельный каталог. Входы рендера, включая установленные `_extensions`, должны входить
в committed export курса. Файлы рабочей копии вне HEAD, включая игнорируемые outputs и кэши, не
экспортируются. Содержимое submodules также отсутствует; неиспользуемые `.platform`/`.ci` gitlinks
допустимы. Внешний checkout расширения может быть submodule рабочего окружения, но его bundle
устанавливается через `quarto add` и коммитится в course tree перед freeze. Отсутствующие пакеты
диагностирует Quarto.

Экспорт учитывает штатные `.gitattributes` (`export-ignore`, `export-subst`) и времена commit;
физические mtime исходной рабочей копии не переносятся. Подготовка и очистка выходов находятся вне
измеряемого интервала. Для сравнения sitemap учитывайте разные commit timestamps; исторические
результаты не исправляются нормализацией.

Повторные `report` и `verify` используют актуальный результат анализа первичных данных. Если записи
были повреждены после запуска, новое качество должно согласованно отражаться в сводке отдельного
запуска и общей сводке; прежняя успешная сборка остаётся отдельным фактом.

## Трассировка выбранных функций

В `scope.modules` перечислите существующие TS/Lua-файлы относительно копии проекта, а в
`scope.extensions` — интересующие идентификаторы расширений. После фиксации источников:

```sh
quarto-course-perf experiment run --config /absolute/perf.json --workspace /absolute/experiment --scenario render-page --mode trace
```

TS-преобразование выполняется только над выбранными файлами подготовленной копии. Receipt сохраняет
хеши исходника/результата и карту символов. Lua trace использует call/return hooks выбранных модулей
и отдельные стеки корутин. `strict: true` отклоняет неподдержанный TS scope до сборки; `skipped`
перечисляет ограничения преобразования. Constructors, generators, accessors, decorators, direct eval
и неподдержанные варианты ручного rebinding не превращаются в заявленное полное покрытие. Compiler
API загружается для TS-преобразования этого пути.

Расширенная диагностика может копировать Quarto share и подключать приватный filter adapter к этой
копии. Он не меняет системный Quarto и не относится к гарантиям публичных hooks простого `render`.
Наличие адаптера, преобразованных символов или реестра само по себе не доказывает исполнение каждой
операции. Проверяйте `coverage.json`, `expectations.json`, события и `quality.coverageComplete`
вместе. Физические копии в `coverage.json.packageCoverage.packages`, их статическая разметка и
отдельные логические `observations` не заменяются флагами агентов TS/Lua. Записанный ID не
доказывает исполнения конкретной установленной копии. Завершённый эксперимент сохраняет результат
нормализации, а не предварительный снимок подготовки.

Для более лёгкого наблюдения того же сценария выбирайте `--mode summary` или `--mode cpu`. В
`report.md` отдельного запуска находятся ссылки на [Perfetto и Speedscope](visualization.md). Часы
TS wall, Lua CPU и некалиброванные локальные шкалы не совмещаются произвольно.

## Парное измерение накладных расходов

```sh
quarto-course-perf experiment benchmark --config /absolute/perf.json --workspace /absolute/experiment --scenario render-page --pairs 10 --seed 42
```

По умолчанию сравниваются `clean-control` и `candidate`; `--left upstream` выбирает исходный
вариант, `--right` также принимает имя варианта. Порог `benchmark.maxSlowdownRatio` обязателен и
явно задаётся в конфигурации; `1.01` в примере означает один процент. Для каждого варианта
выполняется исключённый прогрев, затем пары AB/BA. Hyperfine вызывается с `--shell none`, raw JSON и
частичные результаты сохраняются. Итог использует медиану парных отношений и bootstrap 95% CI.

Если верхняя граница интервала не превышает порог, результат `PASS`; если нижняя выше порога —
`FAIL`; пересечение порога даёт `INCONCLUSIVE`. Один успешный рендер и сравнение HTML не
подтверждают этот порог. Диагностические `summary`/`cpu`/`trace` тоже не заменяют парное измерение
обычного режима.

В отдельных runs внешнее CPU/RSS включает помощник сохранения статуса native child; область указана
в `resourceScope`. В Hyperfine выполняется сама обычная команда без этого помощника; его JSON не
предоставляет исходный сигнал (`signalAvailability: unavailable`).

## Коды завершения

| Код experiment CLI | Значение                                            |
| ------------------ | --------------------------------------------------- |
| `0`                | Действие выполнено; для benchmark порог подтверждён |
| `2`                | Ошибка конфигурации или подготовки                  |
| `3`                | Исходная сборка завершилась неуспешно               |
| `4`                | Диагностические данные невалидны                    |
| `5`                | Benchmark дал `FAIL` или `INCONCLUSIVE`             |

Исходный код и сигнал сборки остаются в `run.json`. Простой `render` сохраняет нативный ненулевой
код вместо преобразования в `3`.

[`scenarios/java.json`](../scenarios/java.json) — мигрированный в v2 пример первоначального полного
Java-пилота с его targets и отдельной политикой сравнения. Он не описывает минимальный курс
`4a427b7207cb0ea7138034087100c372bec410ab`, у которого остались root, `tasks` и `slides`. Подготовка
и результаты текущей приёмки фиксируются отдельно; Cloud VM в этой матрице не проверяется. Для
чтения прежних результатов используйте [явный исторический импорт](migration.md).
