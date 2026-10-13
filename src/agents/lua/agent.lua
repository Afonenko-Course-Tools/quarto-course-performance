-- Внутренний агент: не входит в распространяемые расширения.
return function(config)
  local cpu_provider=pandoc.system.cputime
  local clock = cpu_provider and function()return cpu_provider()/1000000 end or function()return os.clock()*1000000 end
  local agent_source = debug.getinfo(1,'S').source
  local events, counters, errors, active = {}, {}, {}, {}
  local arrays=setmetatable({[events]=true,[errors]=true},{__mode='k'})
  local function quoted(value)
    return '"'..value:gsub('[%z\1-\31\\"]',function(c)
      local known={['"']='\\"',['\\']='\\\\',['\n']='\\n',['\r']='\\r',['\t']='\\t'}
      return known[c] or string.format('\\u%04x',string.byte(c))
    end)..'"'
  end
  local encode
  encode=function(value)
    local kind=type(value)
    if kind=='nil' then return 'null' end
    if kind=='boolean' then return value and 'true' or 'false' end
    if kind=='number' then return tostring(value) end
    if kind=='string' then return quoted(value) end
    assert(kind=='table','Некорректное значение JSON')
    local parts={}
    if arrays[value] then
      for _,item in ipairs(value) do parts[#parts+1]=encode(item) end
      return '['..table.concat(parts,',')..']'
    end
    for key,item in pairs(value) do parts[#parts+1]=quoted(tostring(key))..':'..encode(item) end
    table.sort(parts);return '{'..table.concat(parts,',')..'}'
  end
  local directory=config.outputDirectory..'/events/'..config.processId
  local ok_dir,dir_error=pcall(pandoc.system.make_directory,directory,true)
  if not ok_dir then errors[#errors+1]='mkdir: '..tostring(dir_error) end
  local clock_provider=pandoc.system.cputime and 'pandoc.system.cputime' or 'os.clock'
  local stacks = setmetatable({}, {__mode='k'})
  local main_thread = coroutine.running()
  local sequence, serial, dropped, aborted = 0, 0, 0, 0
  local hooks, manually_wrapped = {}, setmetatable({}, {__mode='k'})
  local function_symbols, symbol_ordinals, symbols = setmetatable({}, {__mode='k'}), {}, {}
  arrays[symbols]=true
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
    if spec.id=='quarto.filter.run' then counters.filter_runs=(counters.filter_runs or 0)+1 end
    local handler=spec.id:match('%.handler%.(.+)$');if handler then local name='handler_calls.'..handler;counters[name]=(counters[name] or 0)+1 end
    if spec.kind=='ast_walk' then
      key='walk_api_calls.'..spec.scope; counters[key]=(counters[key] or 0)+1
      safe_emit{event='counter',kind='ast_walk',origin=spec.origin or 'manual',clock_domain='none',counter={name=key,value=1,quality='observed-exact'}}
    end
    active[id]=spec
    safe_emit{event='begin',kind=spec.kind,span_id=id,parent_span_id=parent,operation_id=spec.id,symbol_id=spec.symbol_id,origin=spec.origin or 'manual',clock_domain='process_cpu',timestamp_us=clock()}
    if push~=false then current[#current+1]=id end
    return id
  end
  local function finish(id,status,pop)
    local spec=active[id]; if not spec then return end
    active[id]=nil
    if status=='aborted' then aborted=aborted+1 end
    safe_emit{event='end',kind=spec.kind,span_id=id,operation_id=spec.id,origin=spec.origin or 'manual',clock_domain='process_cpu',timestamp_us=clock(),status=status}
    if pop~=false then local current=stack(); if current[#current]==id then current[#current]=nil end end
  end
  local function wrap(spec,fn)
    manually_wrapped[fn]=true
    local wrapped=function(...)
      local observed,id=pcall(begin,spec)
      if not observed then errors[#errors+1]='begin: '..tostring(id);id=nil end
      local result=table.pack(pcall(fn,...))
      if id then local ok,err=pcall(finish,id,result[1] and 'ok' or 'error');if not ok then errors[#errors+1]='end: '..tostring(err) end end
      if not result[1] then error(result[2],0) end
      return table.unpack(result,2,result.n)
    end
    manually_wrapped[wrapped]=true; return wrapped
  end
  local function wrap_walk(spec,fn)
    local original=wrap(spec,fn)
    if config.mode~='trace' then return original end
    return function(node,filter,...)
      local observed=setmetatable({},getmetatable(filter))
      for key,value in pairs(filter) do
        observed[key]=type(value)=='function' and wrap({id=spec.id..'.handler.'..tostring(key),kind='function',origin='runtime'},value) or value
      end
      return original(node,observed,...)
    end
  end
  local metrics={wrap_sync=wrap,wrap_walk=wrap_walk,child_env=function(base)
    local env={};for key,value in pairs(base) do env[key]=value end
    env.COURSE_PERF_PARENT_PROCESS_ID=config.processId
    env.COURSE_PERF_PARENT_SPAN_ID=stack()[#stack()]
    return env
  end}
  local function flush()
    local failures=rawget(_G,'__course_performance_failures_v1') or {}
    arrays[failures]=true
    local incomplete=aborted;for _ in pairs(active) do incomplete=incomplete+1 end
    local summary={schema_version=1,experiment_id=config.experimentId,run_id=config.runId,process_id=config.processId,executor_id=executor_id,clock_domain='process_cpu',clock_provider=clock_provider,precision_us="provider-dependent",counters=counters,dropped_events=dropped,incomplete_spans=incomplete,errors=errors,data_valid=dropped==0 and incomplete==0 and #errors==0 and #failures==0}
    summary.abi_failures=failures;summary.symbols=symbols
    local ok,err=pcall(function()
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
        if selected(info.source) and not manually_wrapped[info.func] then
          local symbol=function_symbols[info.func]
          if not symbol then
            local position='lua:'..info.source..':'..info.linedefined..':'..info.lastlinedefined
            symbol_ordinals[position]=(symbol_ordinals[position] or 0)+1
            symbol=position..':'..symbol_ordinals[position];function_symbols[info.func]=symbol
            symbols[#symbols+1]={id=symbol,source=info.source,line=info.linedefined,end_line=info.lastlinedefined,name=info.name or '',identity_scope='runtime-function'}
          end
          id=begin{id=symbol,symbol_id=symbol,kind='function',origin='auto'}
        end
        frames[#frames+1]={id=id,fn=info.func}
      elseif event=='return' then
        -- Calls made before hook installation have no corresponding frame.
        local matched
        for i=#frames,1,-1 do if frames[i].fn==info.func then matched=i;break end end
        if matched then
          for i=#frames,matched+1,-1 do local frame=table.remove(frames);if frame.id then finish(frame.id,'error') end end
          local frame=table.remove(frames);if frame.id then finish(frame.id,'ok') end
        end
      end
    end
    debug.sethook(hook,'cr')
    local create=coroutine.create
    coroutine.create=function(fn)
      local thread=create(fn);debug.sethook(thread,hook,'cr');hooks[thread]=true;return thread
    end
    return true
  end
  local function shutdown() debug.sethook();flush() end
  local agent={abiVersion=1,metrics=metrics,flush=flush,start_trace=start_trace,stop_trace=stop_trace,shutdown=shutdown}
  _G.__course_performance_agent_v1=agent
  return agent
end
