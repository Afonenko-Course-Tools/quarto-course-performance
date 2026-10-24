# Изолированные эксперименты и сравнение

Для повседневного измерения достаточно [простого `render`](diagnostics.md). Команды
`quarto-course-perf experiment` нужны, когда необходимо закрепить исходники, сравнить варианты, явно
заменить полный пакет расширения или трассировать выбранные функции в отдельной копии. Они
используют конфигурацию v2 и не привязаны к имени Java.

## Конфигурация v2

Создайте JSON-файл для своего репозитория. Следующий пример показывает форму данных; замените
`example/course`, ref и цель существующими значениями своего курса:

```json
{
  "schema_version": 2,
  "projectSource": "example/course",
  "sources": [
    {
      "repository": "example/course",
      "refPolicy": "explicit-remote-ref",
      "ref": "refs/heads/main"
    }
  ],
  "replacements": [],
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

`projectSource` выбирается из `sources`. `remote-default-head` вместо `explicit-remote-ref`
разрешает удалённый HEAD; явный `ref` начинается с `refs/`. Полученный SHA записывается в manifest.
В `args` находится полная команда Quarto после имени executable, включая `render` либо `run`.
Рабочий каталог сценария задаётся относительно копии проекта. Поля прежнего пилота `project` и
`courseProfile` не принимаются; профиль передаётся обычными аргументами `--profile`.

Проверьте `cleanPaths` по своему проекту: очищаются только перечисленные пути подготовленной копии.
`clean-output` и `repeat-render` описывают разные политики повторного использования результатов.
Параметры `{course_root}`, `{run_output}` и `{runtime_registry}` подставляются внутри argv без shell
evaluation. Внешний registry задаётся только сценарию, который в нём нуждается.

Точные структуры и валидация находятся в [`src/config/types.ts`](../src/config/types.ts) и
[`src/config/validate.ts`](../src/config/validate.ts). `outputPolicy` по умолчанию равна `strict`.
Именованная `java-pilot-core-qrc-v1` сохраняет совместимость конкретной методики пилота и не
является общим разрешением нормализовать HTML любого курса.

## Получение и фиксация источников

```sh
quarto-course-perf experiment capabilities
quarto-course-perf experiment sources --config /absolute/perf.json --workspace /absolute/baseline
```

`sources` получает GitHub refs и сохраняет SHA, пути и время получения в `manifest.json`. Повторный
вызов в том же workspace использует закреплённый набор, проверяя согласованность выбора. Чтобы
получить актуальные refs заново, выберите новый каталог.

Для фиксации трёх вариантов подготовьте чистые checkout/worktree каждого источника и файл inputs:

```json
{
  "baseline": "/absolute/baseline/manifest.json",
  "variants": {
    "upstream": { "example/course": "/absolute/upstream/course" },
    "clean-control": { "example/course": "/absolute/control/course" },
    "candidate": { "example/course": "/absolute/candidate/course" }
  }
}
```

Каждая mapping должна перечислять ровно все репозитории из `sources`; при одинаковом содержимом
вариантов допускается один и тот же чистый checkout. `upstream` обязан совпадать с SHA baseline.
`freeze` проверяет исходники, закрепляет фактические Deno/Pandoc/Quarto и их хеши и создаёт общий
идентификатор эксперимента. Существующий закреплённый эксперимент не перезаписывается.

```sh
quarto-course-perf experiment freeze --config /absolute/perf.json --workspace /absolute/experiment --inputs /absolute/inputs.json
quarto-course-perf experiment run --config /absolute/perf.json --workspace /absolute/experiment --scenario render-page --variant candidate --mode off
quarto-course-perf experiment report --workspace /absolute/experiment
quarto-course-perf experiment verify --workspace /absolute/experiment
```

`run` каждый раз готовит отдельную копию выбранного варианта. Подготовка, копирование и очистка
выходов находятся вне измеряемого интервала. Файловые mode и доступные mtime/atime сохраняются: это
существенно для нативного `sitemap.xml/lastmod`. Одинаковый Git SHA сам по себе не фиксирует времена
файлов. Исторические результаты с разными mtime не исправляются нормализацией sitemap.

## Явная замена пакетов

Чтобы сравнить изменение расширения, добавьте его репозиторий в `sources`, все три inputs mapping и
`replacements`. Например, один элемент замены Core имеет такую форму:

```json
{
  "repository": "Afonenko-Course-Tools/quarto-course",
  "extensionId": "course-core",
  "destinations": ["_extensions/Afonenko-Course-Tools/course-core"]
}
```

Укажите все нужные размещения полного пакета внутри копии курса, включая самостоятельные вложенные
проекты. Замена не подставляет отдельный bridge поверх пакета иной версии. Пути относительны корню
проекта, содержат `_extensions`, не выходят через `..` и не пересекаются. Подготовка проверяет SHA и
записывает owner SHA, хеш полного пакета и фактические destination paths. Символические ссылки в
потребляемых входах курса/пакета отклоняются.

Пустое `replacements: []` сохраняет установленные в выбранном проекте пакеты. Сам факт наличия
замены в JSON не доказывает, что пакет исполнялся: это подтверждается контекстом событий, сводками,
coverage и receipt конкретного запуска.

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
вместе.

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
