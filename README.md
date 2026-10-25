# Performance для Quarto-курсов

`quarto-course-perf` запускает обычный рендер Quarto и сохраняет время, CPU, пиковую память и отчёт.
Команда работает из привычного каталога проекта с его нативными параметрами; для первого измерения
не нужны конфигурация Performance или регистрация курса.

## Установка и первый запуск

В Arch Linux используйте готовый рецепт из
[quarto-course-perf-arch](https://github.com/Afonenko-Course-Tools/quarto-course-perf-arch).
Сначала установите `base-devel`, `git` и настоящий пакет Quarto, предоставляющий `quarto` в базе
pacman: одного исполняемого файла в `PATH` недостаточно, а `makepkg` не устанавливает зависимости из
AUR. Затем обычным пользователем выполните:

```sh
git clone https://github.com/Afonenko-Course-Tools/quarto-course-perf-arch.git
cd quarto-course-perf-arch
makepkg -si
```

Пакет использует отдельный Deno, установленный Quarto, GNU time и `setsid` из `util-linux`.
`makepkg` подготавливает npm-зависимости; генерировать рецепт или готовить их вручную не нужно.
Для обновления в том же клоне выполните `git pull --ff-only` и повторите `makepkg -si`.
Подробности — в [текущей Arch-инструкции](docs/arch-package.md).

Установленный файл `/usr/share/doc/quarto-course-perf/arch-package.md` из выпуска приложения 2.0.0
сохраняет историческую инструкцию и может описывать прежний маршрут. Актуальная установка и
обновление описаны в README репозитория `quarto-course-perf-arch`; материалы
[выпуска 2.0.0](https://github.com/Afonenko-Course-Tools/quarto-course-performance/releases/tag/v2.0.0)
не заменяются.

Перейдите в каталог, из которого обычно выполняете `quarto render`, и запустите:

```sh
quarto-course-perf render --profile student
```

Профиль `student` нужен только курсу, который его определяет; остальные параметры выбирайте как для
Quarto. После вывода сборки появится краткий итог. Ниже условный пример чисел и пути:

```text
Performance: wall=12.345s; CPU user=9.8; CPU system=1.2; peak RSS=245760 KiB; status=0; data=VALID
Отчёт Performance: /path/to/course/.quarto/course-perf/runs/<run-id>
```

Откройте `report.md` в напечатанном каталоге. `run.json` хранит исходный запрос и результат Quarto,
`summary.json` — наблюдённые операции и счётчики. Результат сборки, пригодность данных и полнота
покрытия оцениваются отдельно. Для долгого хранения задайте `--perf-output` вне публикуемого дерева:
штатная очистка `.quarto` может удалить прежние отчёты.

## Выбор режима

| Режим                | Что сохраняется                                          | Как включить                                                                                                                    |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `off` — по умолчанию | Внешние wall/CPU/RSS и результат сборки                  | `quarto-course-perf render`                                                                                                     |
| `summary`            | Дополнительно доступные ручные операции и счётчики       | `quarto-course-perf render --perf-mode summary`                                                                                 |
| `cpu`                | Дополнительно V8 CPU-профили процессов Deno              | `quarto-course-perf render --perf-mode cpu`                                                                                     |
| `trace`              | Подробная трассировка выбранного scope в отдельной копии | [Изолированный эксперимент](https://github.com/Afonenko-Course-Tools/quarto-course-performance/blob/v2.0.0/docs/experiments.md) |

Параметры `--perf-mode` и `--perf-output` ставятся перед первым аргументом Quarto. Простая команда
сохраняет пользовательские исходники и пакеты; обычные результаты рендера создаёт Quarto. Наличие
расширения или записи в реестре не доказывает выполнения всех его операций. В диагностических
режимах `coverage.json` отдельно хранит физические копии пакетов выбранной области, статические
свидетельства разметки и логические наблюдения. Неизвестные сведения остаются неизвестными;
подключение языкового агента само по себе не означает покрытия пакета.

Веб-справочник версии 2.0.0:
[диагностика и ограничения](https://github.com/Afonenko-Course-Tools/quarto-course-performance/blob/v2.0.0/docs/diagnostics.md)
·
[Perfetto и Speedscope](https://github.com/Afonenko-Course-Tools/quarto-course-performance/blob/v2.0.0/docs/visualization.md)
·
[Эксперименты и сравнение](https://github.com/Afonenko-Course-Tools/quarto-course-performance/blob/v2.0.0/docs/experiments.md)
·
[Переход с 1.0.0](https://github.com/Afonenko-Course-Tools/quarto-course-performance/blob/v2.0.0/docs/migration.md)
·
[Машинные форматы](https://github.com/Afonenko-Course-Tools/quarto-course-performance/blob/v2.0.0/docs/general-use-formats.md).

Для разработчика:
[подготовка зависимостей, проверки, выпуск и владельцы](docs/development.md).
Проверенные SHA, Arch-поставка и ограничения Cybersecurity — в [отчёте реализации](docs/releases/2026-10-24-arch-cybersecurity.md).
Первоначальные
[план](https://github.com/Afonenko-Course-Tools/quarto-course-performance/blob/v2.0.0/docs/plan/README.md)
и
[отчёт Java-пилота](https://github.com/Afonenko-Course-Tools/quarto-course-performance/blob/v2.0.0/docs/java-pilot-report.md)
сохраняют историю версии 1.0.0; они не задают текущую команду запуска.
