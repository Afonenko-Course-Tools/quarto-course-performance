std = "lua54"
codes = true
jobs = 1
max_line_length = false -- Оформлением владеет StyLua, включая длинные аннотации типов.
read_globals = { "pandoc" } -- Реальный API Pandoc в Quarto Lua filters.

files["src/agents/lua/agent.lua"] = {
  -- Агент ставит и снимает proxy только двух функций; остальные поля coroutine read-only.
  globals = { "coroutine.create", "coroutine.wrap" },
}
files["typecheck/native.lua"] = {
  -- Декларации расширяют штатные типы Quarto; этот @meta-файл не исполняется.
  globals = { "pandoc", "quarto" },
}
