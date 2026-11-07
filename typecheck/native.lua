---@meta
-- Дополнение фактических пробелов типов выбранного Quarto 1.11.5.
-- Именованные корни сохраняют поля штатной библиотеки; файл не исполняется.
---@class pandoc
pandoc = pandoc
---@class quarto
quarto = quarto

---@class pandoc.system
---@field cputime? fun():number # CPU-время в пикосекундах; в старом Pandoc функция отсутствует.
pandoc.system = pandoc.system

-- decode(..., false) возвращает JSON без преобразования в userdata AST.
-- Null остаётся штатным light userdata pandoc.json.null.
---@class CoursePerfJsonNull: userdata
---@alias CoursePerfDecodedJson boolean|number|string|CoursePerfJsonNull|table<string|integer,CoursePerfDecodedJson>
---@class CoursePerfPandocJson
pandoc.json = {}
---@type CoursePerfJsonNull
pandoc.json.null = nil
---@param source string
---@param pandoc_types? boolean
---@overload fun(source:string,pandoc_types:false):CoursePerfDecodedJson
---@return unknown
function pandoc.json.decode(source, pandoc_types) end
---@param value unknown
---@return string
function pandoc.json.encode(value) end
