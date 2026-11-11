# Проверка качества собственного TypeScript

Обычная локальная команда и CI используют один блокирующий вход:

```sh
npm ci --ignore-scripts
npm run check-quality
```

Команда проверяет фактические tracked и untracked исходники production из `scope`
в `eslint.config.mjs`. Пустой scope и `strict: false` завершаются ошибкой.
Полный выбранный production scope получает typed ESLint: `no-explicit-any`,
`no-unsafe-type-assertion`, `switch-exhaustiveness-check`, запрет подавляющих
`@ts-ignore`/`@ts-expect-error`/`@ts-nocheck` comments. Inline отключения
правил запрещены; baseline известных нарушений не используется.

Типы берутся из фактического `deno info --json` graph и настоящего `deno types`.
Импорты Quarto берутся из установленного `quarto --paths`; существующие карты
публичных providers сохраняются. Компилятор строит строгую программу с действующими
compilerOptions проекта. Диагностики собственного production scope блокируют
проверку; сторонние библиотеки читаются для разрешения типов, но не объявляются
собственным проверенным кодом. Для объединённых Deno declarations удаляются
только повторные ссылки на уже включённые Deno libs. `skipLibCheck` пропускает семантическую проверку declarations (в том числе
собственных .d.ts адаптеров и сгенерированных validators); их реальные типы
используются при проверке потребляющих production .ts файлов. Полные Deno
source checks сохраняются отдельно.

TypeScript в npm devDependencies обслуживает parser/ESLint. Это не компилятор
продуктового toolchain: существующие Deno, Quarto, системный `tsc` и Compiler API
проверки сохраняют свои команды. Точный host TypeScript не требуется. Финальный
JSON печатает фактические версии TypeScript/parser/ESLint, число типизированных
файлов, число файлов со structural rules и размер прочитанного Deno graph.

`complexity <= 30`, `max-depth <= 5`, `max-params <= 5` блокируют явный законченный
production-пакет `structuralScope` в конфигурации. Эти ограничения пока не покрывают
все старые функции. Это ограничение охвата, а не baseline нарушений: расширение
scope требует содержательной декомпозиции оставшегося долга. Новые файлы в этих
пакетах нужно включать в structuralScope и обычные строгие source inventories.

Dependency-cruiser проверяет настоящий TS/JS import graph и запрещает runtime
циклы во всём production scope. Циклы, содержащие `import type`, разрешены;
публичные границы проверяют и type-only imports. Vendor, node_modules,
generated и _generated исключены. Lua, shell, Python, JS checkJs, installed
копии и hooks/config loading имеют собственные существующие проверки: TS graph
не объявляется проверкой динамически вычисленных импортов или всего расширения.

Новые source файлы не получают произвольных any/stub declarations для зелёного
линтера. Полные старые строгие команды сохраняются отдельно и проверяют также
тесты и служебный код, не входящие в production ESLint scope.

Typed scope — все собственные `src` и `bridge` TypeScript модули.
Структурный пакет — process-модули, фактические Quarto capabilities, json,
protocol types и bridge. Старые normalize/report/render/config/experiment
функции пока не входят в structuralScope. Дополнительные import boundaries:
protocol не зависит от orchestrators, а bridge самодостаточен и не импортирует src.
`deno task check-quality` вызывает тот же npm вход; обычный `deno task check`
начинается с него, затем сохраняет полный source typecheck и Lua/Python/shell.
Системный TypeScript mapping в deno.json остаётся продуктовому Compiler API;
локальный npm TypeScript используется только ESLint инфраструктурой.
