-- Самодостаточный фасад ABI 1; канонический шаблон Performance.
---@class CoursePerfOperationSpec: { id: string, kind: 'phase'|'function'|'ast_walk'|'io'|'command', symbol_id?: string, document_id?: string, attributes?: table<string, string|number|boolean>, origin?: 'manual'|'auto'|'runtime' }

---@class CoursePerfWalkSpec: { id: string, kind: 'ast_walk', scope: 'full-document'|'fragment'|'block'|'inline'|'unknown', symbol_id?: string, document_id?: string, attributes?: table<string, string|number|boolean>, origin?: 'manual'|'auto'|'runtime' }

---@generic T: function
---@param _ CoursePerfOperationSpec
---@param fn T
---@return T
local function identity_wrap(_, fn) return fn end

---@generic T: function
---@param _ CoursePerfWalkSpec
---@param fn T
---@return T
local function identity_walk(_, fn) return fn end

---@param base table<string, string>
---@return table<string, string>
local function identity_env(base) return base end

---@class CoursePerfMetrics
local identity = {
  wrap_sync = identity_wrap,
  wrap_walk = identity_walk,
  child_env = identity_env,
}

---@class CoursePerfAgent: { abiVersion: integer, metrics: CoursePerfMetrics }

---@class CoursePerfRegistry: { __course_performance_agent_v1?: CoursePerfAgent, __course_performance_failures_v1?: string[] }

---@param extension_id string
---@param abi_version? integer
---@return CoursePerfMetrics
local function create_metrics(extension_id, abi_version)
  local mode = os.getenv('COURSE_PERF_MODE')
  if not mode or mode == 'off' then return identity end
  ---@type CoursePerfAgent|nil
  local agent = rawget(_G, '__course_performance_agent_v1')
  if type(agent) == 'table' and agent.abiVersion == (abi_version or 1)
    and type(agent.metrics) == 'table'
    and type(agent.metrics.wrap_sync) == 'function'
    and type(agent.metrics.wrap_walk) == 'function'
    and type(agent.metrics.child_env) == 'function' then
    ---@generic S: CoursePerfOperationSpec
    ---@param spec S
    ---@return S
    local function bound(spec)
      ---@type table<string, string|table<string, string|number|boolean>>
      local copy = {}
      ---@type table<string, string|table<string, string|number|boolean>>
      local fields = spec
      ---@type table<string, string|number|boolean>
      local attributes = {}
      for key, value in pairs(fields) do copy[key] = value end
      ---@type CoursePerfOperationSpec
      local operation = spec
      for key, value in pairs(operation.attributes or {}) do attributes[key] = value end
      attributes.extension_id = extension_id
      copy.attributes = attributes
      return copy
    end
    ---@generic T: function
    ---@param spec CoursePerfOperationSpec
    ---@param fn T
    ---@return T
    local function wrap_sync(spec, fn) return agent.metrics.wrap_sync(bound(spec), fn) end
    ---@generic T: function
    ---@param spec CoursePerfWalkSpec
    ---@param fn T
    ---@return T
    local function wrap_walk(spec, fn) return agent.metrics.wrap_walk(bound(spec), fn) end
    ---@param base table<string, string>
    ---@return table<string, string>
    local function child_env(base) return agent.metrics.child_env(base) end
    return { wrap_sync = wrap_sync, wrap_walk = wrap_walk, child_env = child_env }
  end
  ---@type string[]
  local failures = rawget(_G, '__course_performance_failures_v1') or {}
  _G.__course_performance_failures_v1 = failures
  failures[#failures + 1] = extension_id .. ': агент ABI 1 отсутствует или несовместим'
  return identity
end
return { create_metrics = create_metrics }
