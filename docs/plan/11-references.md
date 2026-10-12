# Первичные источники и повторная проверка

Эти ссылки подтверждают механизмы, использованные в проектировании. Они не заменяют проверку актуальных исходников/runtime при реализации и не фиксируют пилот на Quarto v1.11.5.

| Источник | Использование |
| --- | --- |
| [Quarto: project scripts](https://quarto.org/docs/projects/scripts.html) | Штатные pre/post-render и выполнение TS через Quarto |
| [Quarto resources.ts, v1.11.5](https://github.com/quarto-dev/quarto-cli/blob/v1.11.5/src/core/resources.ts) | Выбор путей Deno/Pandoc через overrides; при реализации перепроверить |
| [Quarto run/deno.ts, v1.11.5](https://github.com/quarto-dev/quarto-cli/blob/v1.11.5/src/core/run/deno.ts) | Формирование arguments отдельного TS-процесса; outer flags нельзя считать автоматически унаследованными |
| [Quarto function-times.ts, v1.11.5](https://github.com/quarto-dev/quarto-cli/blob/v1.11.5/src/core/performance/function-times.ts) | Возврат исходной функции при выключенных метриках; ориентир для off factory |
| [Quarto runemulation.lua, v1.11.5](https://github.com/quarto-dev/quarto-cli/blob/v1.11.5/src/resources/filters/ast/runemulation.lua) | Filter-run boundaries и случаи обхода; не каждый вызов фильтра равен walk |
| [Quarto Lua profiling, v1.11.5](https://github.com/quarto-dev/quarto-cli/blob/v1.11.5/dev-docs/performance-monitoring/pandoc-profiling.md) | Дополнительный backend с подготовленным Lua/Pandoc, не production dependency |
| [Deno CPU profiling](https://docs.deno.com/runtime/fundamentals/cpu_profiling/) | CPU flags, отдельные profiles процессов, ограничения source line mapping |
| [Deno AsyncLocalStorage](https://docs.deno.com/api/node/async_hooks/) | Async context в TS-агенте |
| [Lua 5.4 debug.sethook](https://www.lua.org/manual/5.4/manual.html#pdf-debug.sethook) | Call/return/tail call события и отдельные thread hooks |
| [Lua os.clock](https://www.lua.org/manual/5.4/manual.html#pdf-os.clock) | CPU-часы, которые не являются wall time |
| [Pandoc Lua filters](https://pandoc.org/lua-filters.html) | Инициализация через init.lua, порядок traversal, API walks, process cputime |
| [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) | AST-преобразование только диагностических copies; закрепить совместимый API |
| [Hyperfine](https://github.com/sharkdp/hyperfine) | Повторные benchmark, ресурсы и raw JSON; порядок A/B задаёт runner |
| [Perfetto: external formats](https://perfetto.dev/docs/getting-started/other-formats) | Просмотр экспортированных traces, без требования собственного сервера |

## Что повторно проверить

Версии и hash выбранных binaries, доступность CPU flags/AsyncLocalStorage, сохранение Quarto import maps, data-dir/init.lua во всех Lua states, backend преобразования исходников и packaging layout fresh owners. Существующий профилировщик Lua Quarto использовал `os.clock`: он не даёт оснований объединять его timestamps с wall time TS.

Ни одна ссылка на исторический tag не означает требование откатить актуальную Java или расширения. Runtime compatibility устанавливается capabilities tests и записывается в manifest эксперимента.
