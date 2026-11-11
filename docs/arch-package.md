# Установка quarto-course-perf в Arch Linux

Текущий рецепт
[quarto-course-perf-arch](https://github.com/Afonenko-Course-Tools/quarto-course-perf-arch) собирает
опубликованный
[Performance 2.1.1](https://github.com/Afonenko-Course-Tools/quarto-course-performance/releases/tag/v2.1.1).
Он получает один исходный архив с проверкой SHA-256 и использует системный пакет `typescript` для
Compiler API и `tsc`. Собственного `node_modules` и npm-компилятора в пакете Performance нет; точная
версия системного TypeScript не закрепляется.

## Установка и обновление

Подготовьте `base-devel`, `git` и настоящий установленный пакет Quarto, предоставляющий зависимость
`quarto` в базе pacman. Если выбранный Quarto поставляется через AUR, установите его отдельно:
`makepkg` не разрешает зависимости из AUR. Одной команды `quarto` в `PATH` недостаточно для проверки
зависимости pacman.

Затем обычным пользователем выполните:

```sh
git clone https://github.com/Afonenko-Course-Tools/quarto-course-perf-arch.git
cd quarto-course-perf-arch
makepkg -si
quarto-course-perf --version
```

`makepkg -si` проверяет исходный архив, устанавливает доступные через pacman зависимости, собирает
пакет и выполняет его установку с необходимыми правами. Генерировать рецепт и подготавливать npm
вручную не нужно.

Для обновления в том же клоне:

```sh
git pull --ff-only
makepkg -si
```

Версию и исходный архив выбирает сопровождающий рецепта. Актуальные инструкции упаковки находятся в
его [README](https://github.com/Afonenko-Course-Tools/quarto-course-perf-arch#readme). Документация
внутри уже опубликованных пакетов сохраняет снимок своего исходного выпуска.

## Запуск

Из каталога проекта Quarto:

```sh
quarto-course-perf render --perf-mode summary index.qmd
```

Параметры `--perf-mode` и `--perf-output` ставятся перед первым аргументом Quarto. Остальные
аргументы передаются нативному `quarto render`. По умолчанию режим — `off`; доступны также `summary`
и `cpu`. Результаты сохраняются в `.quarto/course-perf/runs/<runId>` выбранного проекта либо в явно
заданном `--perf-output`. Путь к отчёту печатается после запуска. Смысл метрик, `dataValid` и
неполного покрытия описан в [форматах](general-use-formats.md).

## Зависимости и устройство пакета

| Зависимость  | Назначение                                                 |
| ------------ | ---------------------------------------------------------- |
| `deno`       | Системный runtime команды Performance                      |
| `quarto`     | Установленный Quarto с pacman-провайдером этой зависимости |
| `typescript` | Системные Compiler API и CLI `tsc`                         |
| `time`       | GNU time для CPU-времени и пиковой памяти                  |
| `util-linux` | `setsid` для собственной группы процессов                  |

Дополнительно доступны `hyperfine` для сравнительных измерений, `git` для источников эксперимента и
`unzip` для соответствующих входных архивов. Версии программ, использованные при проверке, не
становятся точными ограничениями рецепта.

`/usr/bin/quarto-course-perf` запускает исходники из `/usr/lib/quarto-course-perf/`: `src/`,
`bridge/`, `deno.json`, `deno.lock` и `docs/operation-registry.json`. На Arch системный Compiler API
находится в `/usr/lib/node_modules/typescript/lib/`; это файлы зависимости `typescript`, а не
вложенные зависимости Performance.

Собственные точки входа получают абсолютные config/lock и `--frozen --cached-only`. Посторонний
`deno.json` курса не становится конфигурацией Performance. Кэши, временные файлы и результаты
записываются в пользовательские каталоги; при необходимости задайте `DENO_DIR`, `XDG_CACHE_HOME` и
`TMPDIR`.

## Проверка пакета до установки

В репозитории упаковки можно проверить исходный архив и получить пути пакетов:

```sh
makepkg --verifysource
makepkg --packagelist
```

Выбирайте существующий основной пакет: список может также содержать предполагаемый путь
debug-пакета. Состав основного файла проверяется командой
`pacman -Qlp /absolute/path/to/package.pkg.tar.zst`.

Checker из того же исходного выпуска запускается через Deno с собственными config/lock. Для проверки
распакованного дерева:

```sh
PERF_SOURCE_ROOT=/absolute/path/to/quarto-course-performance
deno run --config "$PERF_SOURCE_ROOT/deno.json" \
  --lock "$PERF_SOURCE_ROOT/deno.lock" --frozen --cached-only -A \
  "$PERF_SOURCE_ROOT/tools/check-installed.ts" \
  --root /absolute/path/to/usr/lib/quarto-course-perf
```

`--root` указывает на каталог самого приложения. Проверка распаковки и установка через pacman —
отдельные этапы.

Для 2.1.1 прошли настоящие makepkg, установка через pacman в изолированной Arch, пять AST-проверок
системного Compiler API и установленная CLI с native-рендером и TS trace. Проверка CLI выполнена
обычным пользователем без сети, с read-only системным деревом, чужим config и пустым кэшем; состав
приложения не изменился. Использовались Deno 2.9.8, TypeScript 6.0.3 и Quarto 1.11.6.
Hosted-проверка
[Arch PR #1](https://github.com/Afonenko-Course-Tools/quarto-course-perf-arch/pull/1) также прошла.

Приёмка относится к изолированной Arch. Установка на рабочую машину пользователя остаётся отдельным
шагом `makepkg -si`, требующим прав на установку pacman. Сообщения `namcap` сохранены целиком:
отсутствующая лицензия остаётся вопросом правообладателя, а нулевой код `namcap` не означает
отсутствия замечаний.

## Подготовка точного исходного архива

Для сопровождающего исходников `packaging/arch/PKGBUILD` остаётся шаблоном. Из подготовленного Git
checkout выбранного выпуска:

```sh
PERF_SOURCE_ROOT="$PWD"
PERF_COMMIT=$(git rev-parse --verify 'HEAD^{commit}')
PERF_BUILD_ROOT=$(mktemp -d)
deno run --config "$PERF_SOURCE_ROOT/deno.json" \
  --lock "$PERF_SOURCE_ROOT/deno.lock" --frozen --cached-only -A \
  "$PERF_SOURCE_ROOT/tools/prepare-arch-source.ts" \
  --commit "$PERF_COMMIT" --output "$PERF_BUILD_ROOT/source"
```

Генератор создаёт Git-архив, конкретный `PKGBUILD` и `source-receipt.json` с версией, commit и
SHA-256. В репозиторий упаковки переносится проверенный опубликованный рецепт; `.SRCINFO` создаётся
штатным `makepkg --printsrcinfo`. Полный цикл приёмки `bash ci/check-arch.sh /absolute/new/evidence`
и правила выпуска находятся в
[README упаковки](https://github.com/Afonenko-Course-Tools/quarto-course-perf-arch#проверка-и-сопровождение).
Подготовка зависимостей разработки описана в
[development.md](development.md#подготовка-зависимостей).

<a id="проверка-актуальной-реализации-24-октября-2026-года"></a>

## История 2.0.0

Процедуры с npm-архивами, старые QA-таблицы и диагностика `namcap` относятся к
[неизменяемой инструкции 2.0.0](https://github.com/Afonenko-Course-Tools/quarto-course-performance/blob/v2.0.0/docs/arch-package.md)
и
[материалам выпуска 2.0.0](https://github.com/Afonenko-Course-Tools/quarto-course-performance/releases/tag/v2.0.0).
Они сохраняются как исторические свидетельства соответствующих исходников.
