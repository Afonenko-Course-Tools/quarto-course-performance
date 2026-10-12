-- Внутренний агент: не входит в распространяемые расширения.
return function(config)
  local encode = pandoc.json.encode
  local clock = pandoc.system.cputime or os.clock
  local agent_source = debug.getinfo(1,'S').source
  local events, counters, errors, active = {}, {}, {}, {}
  local stacks = setmetatable({}, {__mode='k'})
  local main_thread = coroutine.running()
  local sequence, serial, dropped = 0, 0, 0
  local hooks, manually_wrapped = {}, setmetatable({}, {__mode='k'})
  local executor_id = config.executorId or ('lua-' .. tostring({}):gsub('[^%w]',''))
  local function stack()
    local thread = coroutine.running() or main_thread
    if not stacks[thread] then stacks[thread]={} end
    return stacks[thread]
  end
  local function emit(e)
    sequence=sequence+1
    e.schema_version=1; e.experiment_id=config.experimentId; e.run_id=config.runId
    e.process_id=config.processId; e.executor_id=executor_id; e.sequence=sequence
    if #events < (config.maxEvents or 200000) then events[#events+1]=e else dropped=dropped+1 end
  end
  local function safe_emit(e)
    local ok,err=pcall(emit,e); if not ok then errors[#errors+1]=tostring(err) end
  end
  local function begin(spec, push)
    serial=serial+1; local id=config.processId..'-'..executor_id..'-'..serial
    local current=stack(); local parent=current[#current] or os.getenv('COURSE_PERF_PARENT_SPAN_ID')
    local key='calls.'..spec.id; counters[key]=(counters[key] or 0)+1
    if spec.kind=='ast_walk' then
      key='walk_api_calls.'..spec.scope; counters[key]=(counters[key] or 0)+1
      safe_emit{event='counter',kind='ast_walk',origin=spec.origin or 'manual',clock_domain='none',counter={name=key,value=1,quality='observed-exact'}}
    end
    active[id]=spec
    safe_emit{event='begin',kind=spec.kind,span_id=id,parent_span_id=parent,operation_id=spec.id,symbol_id=spec.symbol_id,origin=spec.origin or 'manual',clock_domain='process_cpu',timestamp_us=clock()*1000000}
    if push~=false then current[#current+1]=id end
    return id
  end
  local function finish(id,status,pop)
    local spec=active[id]; if not spec then return end
    active[id]=nil
    safe_emit{event='end',kind=spec.kind,span_id=id,operation_id=spec.id,origin=spec.origin or 'manual',clock_domain='process_cpu',timestamp_us=clock()*1000000,status=status}
    if pop~=false then local current=stack(); if current[#current]==id then current[#current]=nil end end
  end
  local function wrap(spec,fn)
    manually_wrapped[fn]=true
    local wrapped=function(...)
      local id=begin(spec)
      local result=table.pack(pcall(fn,...))
      finish(id,result[1] and 'ok' or 'error')
      if not result[1] then error(result[2],0) end
      return table.unpack(result,2,result.n)
    end
    manually_wrapped[wrapped]=true; return wrapped
  end
  local metrics={wrap_sync=wrap,wrap_walk=wrap,child_env=function(base)
    local env={};for key,value in pairs(base) do env[key]=value end
    env.COURSE_PERF_PARENT_PROCESS_ID=config.processId
    env.COURSE_PERF_PARENT_SPAN_ID=stack()[#stack()]
    return env
  end}
  local function flush()
    local failures=rawget(_G,'__course_performance_failures_v1') or {}
    local incomplete=0;for _ in pairs(active) do incomplete=incomplete+1 end
    local summary={schema_version=1,experiment_id=config.experimentId,run_id=config.runId,process_id=config.processId,executor_id=executor_id,clock_domain='process_cpu',clock_provider=pandoc.system.cputime and 'pandoc.system.cputime' or 'os.clock',precision_us=1,counters=counters,dropped_events=dropped,incomplete_spans=incomplete,errors=errors,data_valid=dropped==0 and incomplete==0 and #errors==0 and #failures==0}
    summary.abi_failures=failures
    local ok,err=pcall(function()
      local directory=config.outputDirectory..'/events/'..config.processId
      pandoc.system.make_directory(directory,true)
      local file=assert(io.open(directory..'/'..executor_id..'.jsonl','w'))
      for _,event in ipairs(events) do file:write(encode(event),'\n') end;file:close()
      file=assert(io.open(directory..'/'..executor_id..'.summary.json','w'));file:write(encode(summary));file:close()
    end)
    if not ok then errors[#errors+1]='flush: '..tostring(err) end
  end
  local trace_frames=setmetatable({}, {__mode='k'})
  local function stop_trace()
    debug.sethook()
    for thread in pairs(hooks) do if coroutine.status(thread)~='dead' then debug.sethook(thread) end end
    for _,frames in pairs(trace_frames) do
      for i=#frames,1,-1 do if frames[i].id then finish(frames[i].id,'aborted',false) end end
    end
    trace_frames=setmetatable({}, {__mode='k'})
  end
  local function start_trace(scope)
    if debug.gethook() then errors[#errors+1]='Конфликт debug hooks';return false end
    local function selected(source)
      if source==agent_source then return false end
      for _,path in ipairs(scope) do if source:find(path,1,true) then return true end end
      return false
    end
    local hook
    hook=function(event)
      local thread=coroutine.running() or main_thread
      local frames=trace_frames[thread] or {};trace_frames[thread]=frames
      local info=debug.getinfo(2,'fSn')
      if event=='tail call' then
        local previous=table.remove(frames);if previous and previous.id then finish(previous.id,'ok') end
      end
      if event=='call' or event=='tail call' then
        local id
        if selected(info.source) and not manually_wrapped[info.func] then id=begin{id='lua:'..info.source..':'..info.linedefined,kind='function',origin='auto'} end
        frames[#frames+1]={id=id,fn=info.func}
      elseif event=='return' then
        -- Calls made before hook installation have no corresponding frame.
        local frame=frames[#frames]
        if frame and frame.fn==info.func then table.remove(frames);if frame.id then finish(frame.id,'ok') end end
      end
    end
    debug.sethook(hook,'cr')
    local create=coroutine.create
    coroutine.create=function(fn)
      local thread=create(fn);debug.sethook(thread,hook,'cr');hooks[thread]=true;return thread
    end
    return true
  end
  local agent={abiVersion=1,metrics=metrics,flush=flush,start_trace=start_trace,stop_trace=stop_trace}
  _G.__course_performance_agent_v1=agent
  return agent
end
