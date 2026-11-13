# Проверка качества собственного production-кода

Локальная проверка и CI используют одни блокирующие команды:

```sh
npm ci --ignore-scripts
npm run check-quality
npm run check-quality:controls
npm run check:owned
npm run check:owned:controls
# Исправление оформления
npm run format
```

`scope` в `eslint.config.mjs` задаёт production-каталоги. Все существующие и новые tracked/untracked
`.ts`, `.js`, `.cjs`, `.mjs` обнаруживаются автоматически. Vendor, node_modules, generated и
_generated не входят в собственный код. Пустой scope и `strict: false` запрещены. Структурные
правила действуют на весь собственный production-код: `complexity <= 30`, `max-depth <= 5`,
`max-params <= 5`. Списка успешно прошедших старых файлов, baseline и подавлений нет.

Typed ESLint проверяет `no-explicit-any`, `no-unsafe-type-assertion`, `no-unsafe-assignment`,
`no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-return`,
`switch-exhaustiveness-check`. `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` и inline отключения
ESLint завершают gate ошибкой. Линтер печатает конкретные диагностики и считает предупреждения
ошибками. Типизация не заменяется произвольными any или stub API.

Для production TypeScript строится строгая программа из реального `deno info --json` graph,
`deno types` и импортов `deno.json`, включая настоящий системный Compiler API. Проверяются
диагностики собственных production `.ts`. Декларации `.d.ts` обслуживают реальные типы потребителей;
`skipLibCheck` пропускает их отдельную семантическую проверку. Все обнаруженные TS-файлы, включая
тесты и служебные скрипты, отдельно проходят строгий `deno check`.

Production JS/CJS/MJS получает строгую `allowJs/checkJs` программу с настоящими Deno globals и тем
же import graph. Node helpers JS/CJS/MJS в корне и `tools/` получают отдельный строгий
`typecheck/helpers.json` с действительными Node declarations и тот же typed набор ESLint; роль
helper не наследует production structural rules. Разбор внешнего JSON начинается с `unknown` и
проверяет форму реального graph/config/import map.

TypeScript в npm devDependencies — совместимый peer parser/ESLint. Это отдельная зависимость
линтера; системный `tsc`, Compiler API, установленный CLI и Quarto/Deno сохраняют продуктовые
проверки. Точная версия host TypeScript не требуется. TypeScript 7.0.2 фактически отвергнут текущим
parser peer `<6.1.0`; принудительная установка с `--force` или `--legacy-peer-deps` не используется.

Dependency-cruiser проверяет разрешаемый статический TS/JS import graph, публичные границы providers
и runtime cycles. Type-only цикл допускается; импорт внутренних provider modules запрещён и для
type-only связи. Динамически вычисленный импорт не объявляется статически доказанным. Lua, Python и
shell сохраняют собственные существующие language-server/typechecker/lint gates; прохождение TS
graph не означает проверку всего Lua или dynamic graph.

`check-quality:controls` сначала требует чистый production gate, затем по одному создаёт новые
временные production-файлы и Node helpers и запускает ту же `check-quality` команду. Независимо
проверяются каждое правило typed/structural набора, запрет подавления, malformed AST, цикл и импорт
внутренностей. Выход должен быть ненулевым с диагностикой именно проверяемого правила. Файлы
удаляются в `finally`. Эту команду нельзя запускать одновременно с другим source gate того же
checkout. В CI она обязательна после положительного gate. Итоговый JSON положительного входа
сообщает TS/JS/helper/structural counts и реальные версии parser/ESLint/compiler.

Performance `src/` и `bridge/` исполняются Deno. Их обнаруженный JS/CJS/MJS получает отдельную
строгую `checkJs` программу с настоящими `deno types` и тем же разрешённым import graph.
Отрицательный контроль создаёт новый production JS с небезопасным JSON assignment и требует именно
`no-unsafe-assignment`.

`check:owned` автоматически находит tracked и новые untracked файлы вне vendor/generated. Deno
единолично форматирует TS/JS/CJS/MJS, JSON/JSONC и Markdown, включая служебные инструменты и тесты;
его рекомендуемые lint-правила проверяют все собственные скрипты. StyLua форматирует Lua, Luacheck
проверяет предупреждения, Ruff проверяет и форматирует Python, Pyright строго проверяет все новые
Python-файлы, shfmt форматирует shell, ShellCheck проверяет shell и PKGBUILD. Prettier форматирует
YAML; `yamllint --strict` проверяет его стиль и повтор ключей, actionlint проверяет смысл workflow.
Taplo разбирает и форматирует все собственные TOML, включая новые конфигурации. Отсутствующий
инструмент или ненулевой код любого CLI блокирует команду. Для этих форматов дополнительного
владельца оформления нет.

В Luacheck допустим только реальный `pandoc` API. В одном файле агента разрешена запись только в
`coroutine.create` и `coroutine.wrap`: агент устанавливает proxy и восстанавливает исходные функции.
Декларационный `typecheck/native.lua` расширяет `pandoc`/`quarto` и не исполняется. Остальные
globals остаются закрыты. Счётчик закрытия хвостовых кадров намеренно анонимен: на каждой итерации
снимается последний кадр. PKGBUILD содержит исключения SC2034 только у переменных внешнего API
makepkg; неизвестная новая переменная продолжает давать предупреждение. Строгий `checkJs` проверяет
все существующие и новые корневые и `tools/` Node JS/CJS/MJS helpers по настоящим Node declarations;
все обнаруженные TS-файлы проходят `deno check`; типовая ошибка helper блокирует общий gate.
Поведение `package()` проверяется через собранное дерево, настоящий installed CLI, offline render и
TS trace; установка в `/usr` для этого не нужна. Архивные `docs/handoff`, `docs/releases`,
`docs/superpowers`, `docs/plan` и исторический `docs/java-pilot-report.md` сохраняют исходные цитаты
и снимки; действующая документация проверяется автоматически.

`check:owned:controls` создаёт новые файлы по одному и требует отказа той же штатной команды для
ошибки типов Node helper, неоформленного MJS, неизвестных Lua/Python globals, shell quoting,
дублированного YAML ключа, неизвестного workflow поля, ошибочного и неоформленного TOML, ненулевого
exit внешнего CLI. Контроли TS отдельно проверяют обнаружение JS/CJS/MJS одновременно в typed и
structural ESLint. Положительный gate обязателен до отрицательных входов.

ESLint 10.14 совместим с объявленным peer range typescript-eslint и CI Node 24. Два точечных npm
`overrides` направляют minimatch у ESLint и typescript-estree на исправленный 11.0.8. Это временный
совместимый override вне upstream 10.x range для закрытия advisory; после перехода родителей на
исправленную версию его следует удалить. Совместимость подтверждается реальными quality controls,
публичными API minimatch и parser project-service; `npm ls` и `npm audit` должны завершаться без
ошибок. Системный Compiler API и продуктовые зависимости не меняются.
