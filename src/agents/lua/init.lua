local mode=os.getenv('COURSE_PERF_MODE')
if mode and mode~='off' and not rawget(_G,'__course_performance_agent_v1') then
  local install=dofile(assert(os.getenv('COURSE_PERF_AGENT_LUA')))
  local agent=install{experimentId=os.getenv('COURSE_PERF_EXPERIMENT_ID'),runId=os.getenv('COURSE_PERF_RUN_ID'),processId=os.getenv('COURSE_PERF_PROCESS_ID'),outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode=mode}
  if mode=='trace' then
    local file=os.getenv('COURSE_PERF_SCOPE_FILE')
    local scope={}
    if file then local input=assert(io.open(file));scope=pandoc.json.decode(input:read('*a'));input:close() end
    agent.start_trace(scope.luaModules or {})
  end
  -- Lua state shutdown runs finalizers even when a filter raises an error.
  _G.__course_performance_finalizer=setmetatable({}, {__gc=function()agent.stop_trace();agent.flush()end})
end
