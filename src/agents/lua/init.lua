local mode = os.getenv("COURSE_PERF_MODE")
if mode and mode ~= "off" and not rawget(_G, "__course_performance_agent_v1") then
  assert(
    mode == "summary" or mode == "cpu" or mode == "trace",
    "Неизвестный COURSE_PERF_MODE"
  )
  ---@type fun(config:CoursePerfLuaConfig):CoursePerfLuaAgent
  local install = dofile(assert(os.getenv("COURSE_PERF_AGENT_LUA")))
  local agent = install({
    experimentId = assert(os.getenv("COURSE_PERF_EXPERIMENT_ID")),
    runId = assert(os.getenv("COURSE_PERF_RUN_ID")),
    processId = assert(os.getenv("COURSE_PERF_PROCESS_ID")),
    outputDirectory = assert(os.getenv("COURSE_PERF_OUTPUT_DIR")),
    mode = mode,
  })
  if mode == "trace" then
    local file = os.getenv("COURSE_PERF_SCOPE_FILE")
    ---@type string[]
    local selected = {}
    if file then
      local input = assert(io.open(file))
      local scope = pandoc.json.decode(input:read("*a"), false)
      input:close()
      assert(type(scope) == "table", "scope: требуется объект JSON")
      ---@type table<string|integer,CoursePerfDecodedJson>
      local record = scope
      local modules = record.luaModules
      if modules ~= nil then
        assert(
          type(modules) == "table",
          "scope.luaModules: требуется массив строк"
        )
        ---@type table<string|integer,CoursePerfDecodedJson>
        local entries = modules
        for key, value in pairs(entries) do
          assert(
            type(key) == "number" and key % 1 == 0 and key >= 1 and key <= #modules,
            "scope.luaModules: требуется массив строк"
          )
          assert(
            type(value) == "string",
            "scope.luaModules: требуется массив строк"
          )
          selected[key] = value
        end
      end
    end
    agent.start_trace(selected)
  end
  -- Lua state shutdown runs finalizers even when a filter raises an error.
  _G.__course_performance_finalizer = setmetatable({}, {
    __gc = function()
      agent.shutdown()
    end,
  })
end
