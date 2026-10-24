# Установка quarto-course-perf в Arch Linux

`quarto-course-perf` запускает измеряемый рендер Quarto из текущего каталога курса и сохраняет
отчёт. Для установки используется пакет с исходниками TypeScript, Lua и подготовленными
npm-зависимостями. Отдельная компиляция через `deno compile` в этот способ поставки не входит:
инструмент читает и копирует свои файлы, а дочерние процессы запускает через Deno.

Документ описывает подготовку версии 2.0.0. На момент проверки 24 октября 2026 года она ещё не
опубликована. Сборка из точного Git-коммита доступна до выпуска; инструкции получения материалов
Release применимы после их публикации. Отсутствие лицензии исходного проекта и замечания `namcap`
перечислены ниже.

## Зависимости и устройство пакета

| Зависимость  | Назначение                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `deno`       | Отдельный системный runtime команды `quarto-course-perf`                                               |
| `quarto`     | Настоящий пакет Quarto либо пакет с `Provides: quarto`                                                 |
| `time`       | GNU time для CPU-времени и пиковой памяти                                                              |
| `util-linux` | `setsid` для собственной группы процессов рендера                                                      |
| `hyperfine`  | Дополнительно, для сравнительных измерений                                                             |
| `git`        | Дополнительно, для получения исходников эксперимента; также нужен для подготовки локального Git-архива |
| `unzip`      | Дополнительно, для распаковки соответствующих входных данных эксперимента                              |

Наличие только исполняемого файла `quarto` не удовлетворяет зависимости в базе pacman. Если Quarto
получен из пользовательского рецепта, этот рецепт должен создавать настоящий установленный пакет,
предоставляющий `quarto`. Встроенный в Quarto Deno не заменяет отдельную зависимость `deno` команды
приложения. Пакет Performance использует установленный Quarto и не переустанавливает его. Курсы
запускаются от обычного пользователя.

Hyperfine, Git и unzip не нужны для справки или обычного измерения рендера. При отсутствии Git
обычный запуск сохраняет `git: null` в сведениях о происхождении. Расширенное действие проверяет
необходимые ему программы при запуске.

| Путь                                 | Содержимое                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `/usr/bin/quarto-course-perf`        | Небольшая исполняемая оболочка, запускающая Deno                                             |
| `/usr/lib/quarto-course-perf/`       | `src/`, `bridge/`, `node_modules/`, `deno.json`, `deno.lock`, `docs/operation-registry.json` |
| `/usr/share/doc/quarto-course-perf/` | `README.md`, `arch-package.md`, `general-use-formats.md`, `scenarios/`                       |

Оболочка сохраняет текущий каталог пользователя. Собственные файлы приложение находит относительно
`/usr/lib/quarto-course-perf`, учитывая пробелы, `#` и `%` в файловых путях. Собственные точки входа
Deno получают абсолютные пути к конфигурации и lock-файлу приложения, `--frozen`,
`--node-modules-dir=manual` и `--cached-only`. Посторонний `deno.json` курса не становится
конфигурацией Performance; параметры runtime самого курса сохраняются.

В пакет уже включён локальный `node_modules`. Первый запуск не загружает npm-модули и не записывает
файлы приложения в `/usr`. Пользовательский кэш Deno и Quarto, временные каталоги и результаты курса
должны оставаться доступны для записи. Работа без сети проверена для зависимостей и действий самого
инструмента; пользовательский курс может иметь собственные сетевые зависимости. Назначение режима
`manual` описано в [конфигурации Deno](https://docs.deno.com/runtime/reference/deno_json/), общие
способы подготовки зависимостей — в
[документации Deno install](https://docs.deno.com/runtime/reference/cli/install/).

## Подготовка среды сборки

Следующие команды — инструкция для выбранной пользователем Arch-среды. Они устанавливают инструменты
сборки и диагностики пакета:

```sh
sudo pacman -Syu --needed base-devel deno time util-linux namcap
```

Перед сборкой установите выбранный пакет Quarto, предоставляющий `quarto`. Для варианта из Git также
нужен `git`; для загрузки архивов в примерах — `curl`. Сборка выполняется обычным пользователем.
Команда `makepkg -s` разрешает pacman установить объявленные недостающие зависимости. При сборке без
сети все зависимости нужно установить заранее. Назначение `-s`, `--verifysource` и `--packagelist`
определено в [makepkg(8)](https://man.archlinux.org/man/makepkg.8.en).

## Подготовка точного исходного архива

Файл `packaging/arch/PKGBUILD` в Git — шаблон с `@SOURCE_COMMIT@` и `@SOURCE_SHA256@`. Перед
`makepkg` его обязательно преобразуют в конкретный рецепт. Скрипт `tools/prepare-arch-source.ts`
получает полный SHA коммита и новый каталог, создаёт `git archive`, вычисляет SHA-256 и записывает
готовый `PKGBUILD` вместе с `source-receipt.json`. Версия, рецепт и содержимое архива берутся из
выбранного коммита; незакоммиченные изменения в архив не попадают. Каталог назначения не должен
существовать, его родитель должен быть доступен для записи.

Из checkout выбранного коммита репозитория `quarto-course-performance`:

```sh
PERF_SOURCE_ROOT="$PWD"
PERF_COMMIT=$(git rev-parse --verify 'HEAD^{commit}')
PERF_BUILD_DIR="$(mktemp -d)/arch-package"

deno run --config "$PERF_SOURCE_ROOT/deno.json" \
  --lock "$PERF_SOURCE_ROOT/deno.lock" --frozen \
  --node-modules-dir=manual --cached-only -A \
  "$PERF_SOURCE_ROOT/tools/prepare-arch-source.ts" \
  --commit "$PERF_COMMIT" --output "$PERF_BUILD_DIR"

cat "$PERF_BUILD_DIR/source-receipt.json"
cd "$PERF_BUILD_DIR"
```

Для этой версии создаются `quarto-course-perf-2.0.0.tar.gz`, `PKGBUILD` и `source-receipt.json`.
Последний фиксирует SHA коммита, версию и SHA-256 архива. Контрольная сумма архива находится в
отдельном подготовленном рецепте: архив не может включать собственную итоговую контрольную сумму.

После публикации выпуска можно получить готовую пару `PKGBUILD` и исходный архив из его материалов
без локальной подготовки Git-архива. Для будущего `v2.0.0` рецепт использует адрес исходников
[`quarto-course-perf-2.0.0.tar.gz`](https://github.com/Afonenko-Course-Tools/quarto-course-performance/releases/download/v2.0.0/quarto-course-perf-2.0.0.tar.gz).
Готовый
[`PKGBUILD`](https://github.com/Afonenko-Course-Tools/quarto-course-performance/releases/download/v2.0.0/PKGBUILD)
должен быть опубликован рядом с этим архивом в
[материалах выпуска](https://github.com/Afonenko-Course-Tools/quarto-course-performance/releases/tag/v2.0.0).
Эти ссылки описывают будущую поставку, а не подтверждают доступность выпуска. Используйте именно
подготовленный рецепт с конкретными SHA и URL, соответствующий скачанным байтам. Автоматический
архив GitHub `Source code` не заменяет этот архив без новой подготовки и проверки контрольной суммы.

## Исходники npm и сборка без сети

В `deno.lock` закреплены `typescript@5.9.3` и `luaparse@0.3.1`. В `source` рецепта указаны
официальные архивы с SHA-256:

| Архив                                                                                | SHA-256                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [typescript-5.9.3.tgz](https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz) | `10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3` |
| [luaparse-0.3.1.tgz](https://registry.npmjs.org/luaparse/-/luaparse-0.3.1.tgz)       | `facb9742bf9ddecb2a2fa2935d486a05e359db51f5fd6147f4f23d433e3c854b` |

В подготовленном каталоге с конкретным `PKGBUILD` выполните:

```sh
makepkg --verifysource
makepkg -s
makepkg --packagelist
```

`--verifysource` загружает отсутствующие исходники и проверяет их суммы. Для последующей сборки без
сети заранее сохраните все три архива под указанными в рецепте именами рядом с `PKGBUILD` либо в
настроенном `SRCDEST` и установите все зависимости. Локально подготовленный архив приложения уже
лежит рядом с рецептом; скачивать его из ещё не опубликованного Release не требуется. После
подготовки исходников и зависимостей `makepkg -s` работает без сети. Функция `prepare()`
распаковывает npm-архивы в обычные локальные каталоги `node_modules/typescript` и
`node_modules/luaparse`; `check()` запускает CLI с `--cached-only`. Проверка контрольных сумм и
зависимостей остаётся включённой. Поля `source`, `sha256sums` и функции рецепта описаны в
[PKGBUILD(5)](https://man.archlinux.org/man/PKGBUILD.5.en).

`makepkg --packagelist` показывает предполагаемые пути с учётом настроек makepkg. Выберите
существующий основной пакет. При проверке конфигурация `base-devel` также выводила имя возможного
`quarto-course-perf-debug-2.0.0-1-any.pkg.tar.zst`, но такой файл для дерева без ELF не создавался.
Фактически собран основной `quarto-course-perf-2.0.0-1-any.pkg.tar.zst`.

## Проверка пакета до установки

Подставьте абсолютный путь существующего основного файла из `--packagelist`:

```sh
PERF_PACKAGE=/absolute/path/quarto-course-perf-2.0.0-1-any.pkg.tar.zst
pacman -Qlp "$PERF_PACKAGE"
namcap PKGBUILD
namcap "$PERF_PACKAGE"
```

В составе должны присутствовать пути из таблицы устройства пакета. `namcap` нужно читать целиком:
нулевой код завершения не означает отсутствия замечаний. Фактические диагностические сообщения
приведены в конце инструкции.

Для проверки распакованного дерева установка через pacman не нужна. Укажите checkout той же версии,
содержащий `tools/check-installed.ts`. Проверка использует настоящие Deno и Quarto, создаёт
временный небольшой курс и удаляет его после завершения:

```sh
PERF_SOURCE_ROOT=/absolute/path/quarto-course-performance
PERF_EXTRACT_ROOT=$(mktemp -d -t 'course-perf package #%-XXXXXXXX')
bsdtar -xf "$PERF_PACKAGE" -C "$PERF_EXTRACT_ROOT"

deno run --config "$PERF_SOURCE_ROOT/deno.json" \
  --lock "$PERF_SOURCE_ROOT/deno.lock" --frozen \
  --node-modules-dir=manual --cached-only -A \
  "$PERF_SOURCE_ROOT/tools/check-installed.ts" \
  --root "$PERF_EXTRACT_ROOT/usr/lib/quarto-course-perf"
```

`--root` принимает абсолютный путь самого приложения, а не корень распаковки. Проверяются справка,
настоящий `summary`-рендер и отдельный инструментированный TS trace изолированного эксперимента.
Курс содержит посторонний `deno.json`; используются новый пустой `DENO_DIR` и отдельный
`XDG_CACHE_HOME`. Собственные запуски запрещают загрузку модулей через `--cached-only`. Checker
сравнивает хеши дерева приложения до и после работы. Полный запрет сетевого доступа обеспечивает
среда запуска; сам checker не создаёт сетевую изоляцию. Проверка распаковки не заменяет отдельную
проверку установленного `/usr/bin/quarto-course-perf`.

## Установка, запуск, обновление и удаление

После проверки состава и диагностики установка выполняется отдельной командой:

```sh
sudo pacman -U "$PERF_PACKAGE"
```

Затем перейдите в каталог своего курса и запустите команду обычным пользователем:

```sh
quarto-course-perf --version
quarto-course-perf --help
quarto-course-perf render --profile student
quarto-course-perf render --perf-mode summary --profile student
quarto-course-perf render --perf-mode cpu index.qmd
```

По умолчанию используется `off`: внешние время, CPU и память измеряются без внутренней телеметрии.
`summary` собирает доступные сводные наблюдения, `cpu` включает доступное CPU-профилирование. Полный
`trace` запускается через `quarto-course-perf experiment run --mode trace` для подготовленного
изолированного эксперимента. Параметры `--perf-mode` и `--perf-output` ставятся перед первым
аргументом Quarto; последующие аргументы передаются нативному `quarto render`.

По умолчанию результаты каждого запуска находятся в `.quarto/course-perf/runs/<runId>` выбранного
проекта. Иной родительский каталог можно задать через `--perf-output`. Путь к фактическому отчёту
выводится после работы. В `run.json` и `summary.json` пригодность данных `dataValid` оценивается
отдельно от кода сборки; `quality.coverageComplete` не следует считать истинным только из-за
успешного рендера. Обычный рендер сохраняет `quality.coverageComplete: false`. Смысл полей описан в
[форматах измеряемого рендера](general-use-formats.md).

Выбранный Quarto можно указать переменной `QUARTO` с путём к исполняемому файлу. Это не отменяет
зависимость пакета `quarto` в pacman. `DENO_DIR` и `XDG_CACHE_HOME` при необходимости задают
пользовательские каталоги кэша; каталоги `/usr` для этого не используются.

Для обновления получите рецепт и исходники новой точной версии, повторите сборку и проверки в новом
каталоге, затем выполните `sudo pacman -U` с путём к новому пакету. Внутри установленного дерева
обновление зависимостей не выполняется.

Удаление приложения:

```sh
sudo pacman -R quarto-course-perf
```

Результаты в `.quarto/course-perf` проектов и явно выбранных выходных каталогах не принадлежат
пакету и сохраняются после удаления приложения.

## Подготовка исходного checkout для разработки и CI

Установленный пакет уже содержит npm-зависимости. В чистом исходном checkout перед
`deno task check`, `deno task test` и `deno task perf` подготовьте те же локальные каталоги. Ниже
воспроизведён проверенный способ подготовки: загрузка или получение заранее сохранённых официальных
архивов, проверка SHA-256, распаковка. Команды выполняются из корня checkout, с `set -eu`, чтобы
ошибка загрузки или проверки суммы остановила подготовку.

```sh
set -eu
if [ -z "${NPM_SOURCE_DIR:-}" ]; then
  NPM_SOURCE_DIR=$(mktemp -d)
  curl --fail --location --output "$NPM_SOURCE_DIR/typescript-5.9.3.tgz" \
    https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz
  curl --fail --location --output "$NPM_SOURCE_DIR/luaparse-0.3.1.tgz" \
    https://registry.npmjs.org/luaparse/-/luaparse-0.3.1.tgz
fi
printf '%s  %s\n' \
  10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3 \
  "$NPM_SOURCE_DIR/typescript-5.9.3.tgz" \
  facb9742bf9ddecb2a2fa2935d486a05e359db51f5fd6147f4f23d433e3c854b \
  "$NPM_SOURCE_DIR/luaparse-0.3.1.tgz" | sha256sum -c -
mkdir -p node_modules/typescript node_modules/luaparse
tar -xzf "$NPM_SOURCE_DIR/typescript-5.9.3.tgz" \
  --strip-components=1 -C node_modules/typescript
tar -xzf "$NPM_SOURCE_DIR/luaparse-0.3.1.tgz" \
  --strip-components=1 -C node_modules/luaparse
```

Если архивы уже получены, перед блоком задайте `NPM_SOURCE_DIR=/absolute/path/to/npm-archives`;
загрузка будет пропущена, а проверка сумм сохранится. Этот шаг относится к сборке и разработке.
Установленная команда не выполняет такую подготовку при первом запуске.

Этот блок подготавливает локальные модули runtime. Внешний `deno task` и проверки типов могут
дополнительно заполнять пользовательский кэш Deno: запуск `deno task perf --help` с неподготовленным
кэшем пытался загрузить npm-архивы ещё до выполнения задачи. Для разработки и CI без сети этот кэш
подготавливают отдельно; работа таких проверок с пустым кэшем здесь не гарантируется. Проверенная
команда самого приложения использует явные `--config`, `--lock`, `--frozen`,
`--node-modules-dir=manual` и `--cached-only`, как в оболочке `/usr/bin/quarto-course-perf`.

## Проверенные среды и ограничения

Предвыпускная проверка пакета выполнена для исходного коммита
`88e561f7f9390c28f8b2f4ac86b5f4ba22cbfea7` на Linux x86-64. Документ добавлен после этого коммита;
сборку пакета с новой документацией и окончательные байты публичного выпуска нужно проверять
отдельно. `arch=('any')` описывает состав исходников без архитектурно зависимых бинарных файлов и не
подтверждает проверку всех архитектур.

| Проверка                                          | Среда и результат                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Локальные проверки реализации                     | Системный Quarto 1.11.6 и встроенный в него Deno 2.7.14; 227 тестов и 13 шагов прошли                                                                                      |
| Распакованный настоящий пакет                     | Deno 2.7.14, Quarto 1.11.6; справка, `summary`-рендер и отдельный TS trace прошли                                                                                          |
| Сборка пакета в изолированной Arch                | Обычный `builder` с UID 1000, `makepkg -s`, сеть отключена; три SHA-256, `prepare()`, `check()` и `package()` прошли                                                       |
| Установка через pacman в отдельный контейнер Arch | `deno 2.9.8-1`, `quarto-cli-bin-pre-release 1.11.6-1` с `Provides: quarto`, `time 1.10-1`, `util-linux 2.42.4-1`; настоящий `/usr/bin/quarto-course-perf` и checker прошли |

В Arch команда Performance работала через отдельный Deno 2.9.8, а Quarto использовал собственный
Deno 2.7.14. После установки проверка выполнялась обычным пользователем с корневой файловой системой
только для чтения, доступным для записи `/tmp` и отключённой сетью. Git, Hyperfine и unzip в этой
среде отсутствовали. Справка, версия, настоящий `summary`-рендер и отдельный TS trace завершились
успешно. Проверка охватывает путь с пробелами, `#` и `%`, чужой `deno.json`, пустой кэш и равенство
хешей приложения до и после запуска. TS-проверка потребовала `dataValid: true`, свидетельство
`ts-transform` и реальное событие `begin` с идентификатором инструментированной функции. Это
небольшой изолированный эксперимент, а не подтверждение полного покрытия произвольного курса.

Установка на рабочую машину пользователя и публикация в AUR в эту проверку не входили. Успех
установки в контейнере не подтверждает выполнение этих действий.

### Диагностика namcap и лицензия

В проверенной Arch использовался `namcap 3.6.0-3`. Проверки рецепта и пакета вернули код 0, но
оставили следующие замечания:

```text
PKGBUILD (quarto-course-perf) W: Missing Maintainer tag
PKGBUILD (quarto-course-perf) E: Missing license
quarto-course-perf E: Missing license
quarto-course-perf E: Missing license
quarto-course-perf W: Referenced library 'node' is an uninstalled dependency (needed in files ['usr/lib/quarto-course-perf/node_modules/typescript/bin/tsserver', 'usr/lib/quarto-course-perf/node_modules/luaparse/bin/luaparse', 'usr/lib/quarto-course-perf/node_modules/typescript/bin/tsc'])
quarto-course-perf W: Referenced library 'sh' is an uninstalled dependency (needed in files ['usr/bin/quarto-course-perf'])
quarto-course-perf W: Dependency included, but may not be needed ('deno')
quarto-course-perf W: Dependency included, but may not be needed ('quarto')
quarto-course-perf W: Dependency included, but may not be needed ('time')
quarto-course-perf W: Dependency included, but may not be needed ('util-linux')
```

В исходном проекте нет лицензии; `license=()` сохраняет это обстоятельство. Выбор лицензии требует
решения правообладателя. Лицензии вложенных npm-пакетов сохраняются в их каталогах и не задают
лицензию самого Performance. Нулевой код `namcap` не является чистой проверкой или решением о
лицензировании. Сопровождающий пакета также не назначался искусственно ради устранения
предупреждения.

Предупреждение `node` относится к сохранённым upstream-командам `tsc`, `tsserver` и `luaparse`;
приложение их не вызывает, а использует модули через Deno. Предупреждение `sh` относится к
запускающей оболочке: в проверенной базовой Arch присутствовал bash, и оболочка действительно
выполнялась. Зависимости `deno`, `quarto`, `time` и `util-linux` вызываются динамически из
TypeScript; предупреждения об их возможной ненужности не отменяют требований рецепта.
