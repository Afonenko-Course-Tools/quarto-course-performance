-- Внутренний агент: не входит в распространяемые расширения.
---@alias CoursePerfJson nil|boolean|number|string|table<string|integer, CoursePerfJson>
---@alias CoursePerfStatus 'ok'|'error'|'aborted'
---@class CoursePerfLuaConfig
---@field experimentId string
---@field runId string
---@field processId string
---@field outputDirectory string
---@field mode 'summary'|'cpu'|'trace'
---@field executorId? string
---@field maxEvents? integer

---@class CoursePerfPendingEvent
---@field schema_version? integer
---@field experiment_id? string
---@field run_id? string
---@field process_id? string
---@field executor_id? string
---@field sequence? integer
---@field event 'begin'|'end'|'counter'|'quality'
---@field kind 'phase'|'function'|'ast_walk'|'io'|'command'
---@field origin 'manual'|'auto'|'runtime'
---@field clock_domain 'monotonic_process'|'process_cpu'|'none'
---@field span_id? string
---@field parent_span_id? string
---@field operation_id? string
---@field symbol_id? string
---@field document_id? string
---@field timestamp_us? number
---@field status? CoursePerfStatus
---@field counter? {name:string,value:number,quality:'observed-exact'|'partial'}
---@field attributes? table<string,string|number|boolean>

---@class CoursePerfLuaFrame
---@field id? string
---@field fn function
---@field tails? CoursePerfLuaFrame[]

---@class CoursePerfLuaAgent: CoursePerfAgent
---@field flush fun()
---@field start_trace fun(scope:string[]):boolean?
---@field stop_trace fun()
---@field shutdown fun()

---@param config CoursePerfLuaConfig
---@return CoursePerfLuaAgent
return function(config)
  ---@type (fun():number)?
  local cpu_provider = pandoc.system.cputime
  local clock = cpu_provider and function()
    return cpu_provider() / 1000000
  end or function()
    return os.clock() * 1000000
  end
  local agent_source = debug.getinfo(1, "S").source
  ---@type CoursePerfPendingEvent[]
  local events = {}
  ---@type table<string, number>
  local counters = {}
  ---@type string[]
  local errors = {}
  ---@type table<string, {spec:CoursePerfOperationSpec,document_id?:string,attributes?:table<string,string|number|boolean>}>
  local active = {}
  local arrays = setmetatable({ [events] = true, [errors] = true }, { __mode = "k" })
  ---@param value string
  ---@return string
  local function quoted(value)
    return '"'
      .. value:gsub('[%z\1-\31\\"]', function(c)
        local known =
          { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
        return known[c] or string.format("\\u%04x", string.byte(c))
      end)
      .. '"'
  end
  ---@type fun(value:CoursePerfJson):string
  local encode
  encode = function(value)
    local kind = type(value)
    if kind == "nil" then
      return "null"
    end
    if kind == "boolean" then
      return value and "true" or "false"
    end
    if kind == "number" then
      return tostring(value)
    end
    if kind == "string" then
      return quoted(value)
    end
    assert(type(value) == "table", "Некорректное значение JSON")
    ---@type table<string|integer,CoursePerfJson>
    local entries = value
    ---@type string[]
    local parts = {}
    if arrays[value] then
      for _, item in ipairs(entries) do
        parts[#parts + 1] = encode(item)
      end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for key, item in pairs(entries) do
      parts[#parts + 1] = quoted(tostring(key)) .. ":" .. encode(item)
    end
    table.sort(parts)
    return "{" .. table.concat(parts, ",") .. "}"
  end
  local directory = config.outputDirectory .. "/events/" .. config.processId
  local ok_dir, dir_error = pcall(pandoc.system.make_directory, directory, true)
  if not ok_dir then
    errors[#errors + 1] = "mkdir: " .. tostring(dir_error)
  end
  local clock_provider = pandoc.system.cputime and "pandoc.system.cputime" or "os.clock"
  ---@type table<thread, string[]>
  local stacks = setmetatable({}, { __mode = "k" })
  local main_thread = assert(coroutine.running())
  local sequence, serial, dropped, aborted = 0, 0, 0, 0
  ---@type table<thread, boolean>
  local hooks = setmetatable({}, { __mode = "k" })
  ---@type table<function, boolean>
  local manually_wrapped = setmetatable({}, { __mode = "k" })
  ---@type table<thread, string>
  local creator_spans = setmetatable({}, { __mode = "k" })
  local native_create, native_wrap = coroutine.create, coroutine.wrap
  ---@type fun(event:string,line?:integer)?
  local active_hook
  ---@type table<function, string>
  local function_symbols = setmetatable({}, { __mode = "k" })
  ---@type table<string, integer>
  local symbol_ordinals = {}
  ---@type {id:string,source:string,line:integer,end_line:integer,name:string,identity_scope:string}[]
  local symbols = {}
  arrays[symbols] = true
  local executor_id = config.executorId or ("lua-" .. tostring({}):gsub("[^%w]", ""))
  local started, start_error = pcall(function()
    local file = assert(io.open(directory .. "/" .. executor_id .. ".started.json", "w"))
    file:write(encode({
      schema_version = 1,
      process_id = config.processId,
      executor_id = executor_id,
      agent = "lua",
      executed = true,
    }))
    file:close()
  end)
  if not started then
    errors[#errors + 1] = "activation: " .. tostring(start_error)
  end
  ---@return string[]
  local function stack()
    local thread = coroutine.running() or main_thread
    if not stacks[thread] then
      stacks[thread] = {}
    end
    return stacks[thread]
  end
  ---@param e CoursePerfPendingEvent
  local function emit(e)
    sequence = sequence + 1
    e.schema_version = 1
    e.experiment_id = config.experimentId
    e.run_id = config.runId
    e.process_id = config.processId
    e.executor_id = executor_id
    e.sequence = sequence
    if #events < (config.maxEvents or 200000) then
      events[#events + 1] = e
    else
      dropped = dropped + 1
    end
  end
  ---@param e CoursePerfPendingEvent
  local function safe_emit(e)
    local ok, err = pcall(emit, e)
    if not ok then
      errors[#errors + 1] = tostring(err)
    end
  end
  ---@param spec CoursePerfOperationSpec
  ---@return string?,table<string,string|number|boolean>?
  local function document_context(spec)
    local document = spec.document_id
    local public = rawget(_G, "quarto")
    if not document and public and public.doc then
      ---@type nil|boolean|number|string|table|function|userdata|thread
      local input = public.doc.input_file
      if type(input) == "string" then
        document = input
      end
    end
    if type(document) ~= "string" or document == "" then
      document = nil
    end
    ---@type table<string,string|number|boolean>?
    local attributes
    if spec.attributes then
      attributes = {}
      for key, value in pairs(spec.attributes) do
        attributes[key] = value
      end
    end
    return document, attributes
  end
  ---@param spec CoursePerfOperationSpec|CoursePerfWalkSpec
  ---@param push? boolean
  ---@return string
  local function begin(spec, push)
    serial = serial + 1
    local id = config.processId .. "-" .. executor_id .. "-" .. serial
    local current = stack()
    local parent = current[#current]
      or creator_spans[coroutine.running() or main_thread]
      or os.getenv("COURSE_PERF_PARENT_SPAN_ID")
    local document, attributes = document_context(spec)
    ---@type string
    local key = "calls." .. spec.id
    counters[key] = (counters[key] or 0) + 1
    if spec.id == "quarto.filter.run" then
      counters.filter_runs = (counters.filter_runs or 0) + 1
    end
    local handler = spec.id:match("%.handler%.(.+)$")
    if handler then
      ---@type string
      local name = "handler_calls." .. handler
      counters[name] = (counters[name] or 0) + 1
    end
    if spec.kind == "ast_walk" then
      assert(type(spec.scope) == "string", "scope: требуется строка")
      key = "walk_api_calls." .. tostring(spec.scope)
      counters[key] = (counters[key] or 0) + 1
      safe_emit({
        document_id = document,
        attributes = attributes,
        event = "counter",
        kind = "ast_walk",
        origin = spec.origin or "manual",
        clock_domain = "none",
        counter = { name = key, value = 1, quality = "observed-exact" },
      })
    end
    active[id] = { spec = spec, document_id = document, attributes = attributes }
    safe_emit({
      document_id = document,
      attributes = attributes,
      event = "begin",
      kind = spec.kind,
      span_id = id,
      parent_span_id = parent,
      operation_id = spec.id,
      symbol_id = spec.symbol_id,
      origin = spec.origin or "manual",
      clock_domain = "process_cpu",
      timestamp_us = clock(),
    })
    if push ~= false then
      current[#current + 1] = id
    end
    return id
  end
  ---@param id string
  ---@param status CoursePerfStatus
  ---@param pop? boolean
  local function finish(id, status, pop)
    local observation = active[id]
    if not observation then
      return
    end
    local spec = observation.spec
    active[id] = nil
    if status == "aborted" then
      aborted = aborted + 1
    end
    safe_emit({
      document_id = observation.document_id,
      attributes = observation.attributes,
      event = "end",
      kind = spec.kind,
      span_id = id,
      operation_id = spec.id,
      origin = spec.origin or "manual",
      clock_domain = "process_cpu",
      timestamp_us = clock(),
      status = status,
    })
    if pop ~= false then
      local current = stack()
      if current[#current] == id then
        current[#current] = nil
      end
    end
  end
  ---@generic T: function
  ---@param spec CoursePerfOperationSpec
  ---@param fn T
  ---@return T
  local function wrap(spec, fn)
    -- В summary/cpu сохраняются document phases и shortcode boundaries,
    -- но поузловые filter handlers наблюдаются только при явном trace.
    if
      config.mode ~= "trace"
      and spec.kind == "function"
      and spec.id:find(".handler.", 1, true)
      and not spec.id:find(".shortcodes.handler.", 1, true)
    then
      return fn
    end
    manually_wrapped[fn] = true
    local wrapped = function(...)
      local observed, result_id = pcall(begin, spec)
      ---@type string?
      local id
      if observed then
        id = result_id
      else
        errors[#errors + 1] = "begin: " .. tostring(result_id)
      end
      local result = table.pack(pcall(fn, ...))
      if id then
        local ok, err = pcall(finish, id, result[1] and "ok" or "error")
        if not ok then
          errors[#errors + 1] = "end: " .. tostring(err)
        end
      end
      if not result[1] then
        error(result[2], 0)
      end
      return table.unpack(result, 2, result.n)
    end
    manually_wrapped[wrapped] = true
    return wrapped
  end
  ---@generic T: function
  ---@param spec CoursePerfWalkSpec
  ---@param fn T
  ---@return T
  local function wrap_walk(spec, fn)
    ---@type function
    local original = wrap(spec, fn)
    if config.mode ~= "trace" then
      return original
    end
    ---@param node pandoc.Pandoc|pandoc.Block|pandoc.Inline|pandoc.Blocks|pandoc.Inlines
    ---@param filter table<string,function|string|boolean>
    return function(node, filter, ...)
      ---@type table<string,function|string|boolean>
      local observed = setmetatable({}, getmetatable(filter))
      for key, value in pairs(filter) do
        observed[key] = type(value) == "function"
            and wrap({
              id = spec.id .. ".handler." .. tostring(key),
              kind = "function",
              origin = "runtime",
              document_id = spec.document_id,
              attributes = spec.attributes,
            }, value)
          or value
      end
      return original(node, observed, ...)
    end
  end
  local metrics = {
    wrap_sync = wrap,
    wrap_walk = wrap_walk,
    child_env =
      ---@param base table<string,string>
      ---@return table<string,string>
      function(base)
        ---@type table<string,string>
        local env = {}
        for key, value in pairs(base) do
          env[key] = value
        end
        env.COURSE_PERF_PARENT_PROCESS_ID = config.processId
        env.COURSE_PERF_PARENT_SPAN_ID = stack()[#stack()]
        return env
      end,
  }
  ---@param thread thread
  ---@param parent? string
  local function register_thread(thread, parent)
    creator_spans[thread] = parent
    hooks[thread] = true
    if active_hook then
      debug.sethook(thread, active_hook, "cr")
    end
  end
  ---@param fn function
  ---@return thread
  local create_proxy = function(fn)
    local parent = stack()[#stack()]
    ---@type thread
    local thread = native_create(fn)
    register_thread(thread, parent)
    return thread
  end
  ---@generic T:function
  ---@param fn T
  ---@return T
  local wrap_proxy = function(fn)
    local parent = stack()[#stack()]
    ---@type function
    local wrapped = native_wrap(fn)
    local _, thread = debug.getupvalue(wrapped, 1)
    if type(thread) == "thread" then
      register_thread(thread, parent)
    else
      errors[#errors + 1] = "coroutine.wrap: thread identity недоступна"
    end
    return wrapped
  end
  coroutine.create = create_proxy
  coroutine.wrap = wrap_proxy
  local function flush()
    ---@type string[]
    local failures = rawget(_G, "__course_performance_failures_v1") or {}
    arrays[failures] = true
    ---@type integer
    local incomplete = aborted
    for _ in pairs(active) do
      incomplete = incomplete + 1
    end
    ---@type table<string,CoursePerfJson>
    local summary = {
      schema_version = 1,
      experiment_id = config.experimentId,
      run_id = config.runId,
      process_id = config.processId,
      executor_id = executor_id,
      clock_domain = "process_cpu",
      clock_provider = clock_provider,
      precision_us = "provider-dependent",
      counters = counters,
      dropped_events = dropped,
      incomplete_spans = incomplete,
      errors = errors,
      data_valid = dropped == 0 and incomplete == 0 and #errors == 0 and #failures == 0,
    }
    summary.abi_failures = failures
    summary.symbols = symbols
    local ok, err = pcall(function()
      local file = assert(io.open(directory .. "/" .. executor_id .. ".jsonl", "w"))
      for _, event in ipairs(events) do
        file:write(encode(event), "\n")
      end
      file:close()
      file = assert(io.open(directory .. "/" .. executor_id .. ".summary.json", "w"))
      file:write(encode(summary))
      file:close()
    end)
    if not ok then
      errors[#errors + 1] = "flush: " .. tostring(err)
    end
  end
  ---@type table<thread, CoursePerfLuaFrame[]>
  local trace_frames = setmetatable({}, { __mode = "k" })
  local function disable_hooks()
    if active_hook and debug.gethook() == active_hook then
      debug.sethook()
    end
    for thread in pairs(hooks) do
      if debug.gethook(thread) == active_hook then
        debug.sethook(thread)
      end
    end
    active_hook = nil
  end
  ---@param frame CoursePerfLuaFrame
  ---@param status CoursePerfStatus
  local function close_frame(frame, status)
    if frame.id then
      finish(frame.id, status)
    end
    for i = #(frame.tails or {}), 1, -1 do
      if frame.tails[i].id then
        finish(frame.tails[i].id, status)
      end
    end
  end
  local function stop_trace()
    disable_hooks()
    for _, frames in pairs(trace_frames) do
      for i = #frames, 1, -1 do
        close_frame(frames[i], "aborted")
      end
    end
    for _, current in pairs(stacks) do
      for i = #current, 1, -1 do
        if not active[current[i]] then
          table.remove(current, i)
        end
      end
    end
    trace_frames = setmetatable({}, { __mode = "k" })
  end
  ---@param scope string[]
  ---@return boolean?
  local function start_trace(scope)
    if debug.gethook() then
      errors[#errors + 1] = "Конфликт debug hooks"
      return false
    end
    for thread in pairs(hooks) do
      if debug.gethook(thread) then
        errors[#errors + 1] = "Конфликт coroutine debug hooks"
        return false
      end
    end
    ---@param source string
    ---@return string?
    local function identity(source)
      if source:sub(1, 1) == "@" then
        source = source:sub(2)
      end
      if source:sub(1, 1) == "=" then
        return nil
      end
      if pandoc.path.is_relative(source) then
        source = pandoc.path.join({ pandoc.system.get_working_directory(), source })
      end
      return pandoc.path.normalize(source)
    end
    ---@type table<string,boolean>
    local selected_files = {}
    for _, path in ipairs(scope) do
      local file = identity(path)
      if file then
        selected_files[file] = true
      end
    end
    local own_file = identity(agent_source)
    ---@param source string
    ---@return boolean?
    local function selected(source)
      local file = identity(source)
      return file and file ~= own_file and selected_files[file] == true
    end
    ---@type fun(event:string,line?:integer)
    local hook
    hook = function(event)
      local thread = coroutine.running() or main_thread
      ---@type CoursePerfLuaFrame[]
      local frames = trace_frames[thread] or {}
      trace_frames[thread] = frames
      local info = debug.getinfo(2, "fSn")
      ---@type CoursePerfLuaFrame[]?
      local tails
      if event == "tail call" then
        ---@type CoursePerfLuaFrame?
        local previous = table.remove(frames)
        if previous then
          ---@type CoursePerfLuaFrame[]
          local inherited = previous.tails or {}
          previous.tails = nil
          inherited[#inherited + 1] = previous
          tails = inherited
        end
      end
      if event == "call" or event == "tail call" then
        ---@type string?
        local id
        if selected(info.source) and not manually_wrapped[info.func] then
          local symbol = function_symbols[info.func]
          if not symbol then
            local position = "lua:"
              .. info.source
              .. ":"
              .. info.linedefined
              .. ":"
              .. info.lastlinedefined
            symbol_ordinals[position] = (symbol_ordinals[position] or 0) + 1
            symbol = position .. ":" .. symbol_ordinals[position]
            function_symbols[info.func] = symbol
            symbols[#symbols + 1] = {
              id = symbol,
              source = info.source,
              line = info.linedefined,
              end_line = info.lastlinedefined,
              name = info.name or "",
              identity_scope = "runtime-function",
            }
          end
          id = begin({ id = symbol, symbol_id = symbol, kind = "function", origin = "auto" })
        end
        frames[#frames + 1] = { id = id, fn = info.func, tails = tails }
      elseif event == "return" then
        -- Calls made before hook installation have no corresponding frame.
        ---@type integer?
        local matched
        for i = #frames, 1, -1 do
          if frames[i].fn == info.func then
            matched = i
            break
          end
        end
        if matched then
          -- Счётчик задаёт число закрываемых кадров; удаляется последний кадр.
          for _ = #frames, matched + 1, -1 do
            close_frame(table.remove(frames), "error")
          end
          close_frame(table.remove(frames), "ok")
        end
      end
    end
    active_hook = hook
    debug.sethook(hook, "cr")
    for thread in pairs(hooks) do
      if coroutine.status(thread) ~= "dead" then
        debug.sethook(thread, hook, "cr")
      end
    end
    return true
  end
  local function shutdown()
    disable_hooks()
    if coroutine.create == create_proxy then
      coroutine.create = native_create
    end
    if coroutine.wrap == wrap_proxy then
      coroutine.wrap = native_wrap
    end
    flush()
  end
  local agent = {
    abiVersion = 1,
    metrics = metrics,
    flush = flush,
    start_trace = start_trace,
    stop_trace = stop_trace,
    shutdown = shutdown,
  }
  _G.__course_performance_agent_v1 = agent
  return agent
end
