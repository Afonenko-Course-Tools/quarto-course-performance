import { strict as assert } from "node:assert";
import { join } from "node:path";
const project=new URL("../../",import.meta.url).pathname;
const pandoc=Deno.env.get("PERF_PANDOC")??"/opt/quarto/bin/tools/pandoc";
async function fixture(source:string,mode="summary") {
  const root=await Deno.makeTempDir();
  try {
    const path=join(root,"fixture.lua");await Deno.writeTextFile(path,source);
    const out=await new Deno.Command(pandoc,{args:["--lua-filter",path,"-t","plain"],env:{COURSE_PERF_MODE:mode,COURSE_PERF_OUTPUT_DIR:root},stdin:"null",stdout:"piped",stderr:"piped"}).output();
    assert(out.success,new TextDecoder().decode(out.stderr));
    let result:unknown;try{result=JSON.parse(await Deno.readTextFile(join(root,"events/p/lua.summary.json")));}catch{result=null;}
    return {result,stdout:new TextDecoder().decode(out.stdout)};
  }finally{await Deno.remove(root,{recursive:true});}
}
Deno.test("Lua off preserves identity, multiple nil returns and does not install hooks",async()=>{
  await fixture(`local bridge=dofile(${JSON.stringify(project+"bridge/bridge.lua")})
local m=bridge.create_metrics('test',1)
local f=function() return 1,nil,3,nil end
assert(m.wrap_sync({id='n',kind='function'},f)==f)
assert(m.wrap_walk({id='w',kind='ast_walk',scope='fragment'},f)==f)
local env={x='y'}; assert(m.child_env(env)==env)
local a=table.pack(f()); assert(a.n==4 and a[3]==3 and a[4]==nil)
assert(debug.gethook()==nil)
return {}`,"off");
});
Deno.test("Lua wrappers preserve nil/error identity and nested walk scopes across coroutines",async()=>{
  const {result}=await fixture(`local install=dofile(${JSON.stringify(project+"src/agents/lua/agent.lua")})
local a=install{experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='summary'}
local m=dofile(${JSON.stringify(project+"bridge/bridge.lua")}).create_metrics('test',1)
local err={code=42}
local f=m.wrap_sync({id='returns',kind='function'},function()return 1,nil,3,nil end)
local values=table.pack(f());assert(values.n==4 and values[3]==3)
local bad=m.wrap_sync({id='bad',kind='function'},function()error(err)end)
local ok,e=pcall(bad);assert(not ok and e==err)
local frag=m.wrap_walk({id='frag',kind='ast_walk',scope='fragment'},function(doc) return doc:walk({Str=function(s)return s end})end)
local full=m.wrap_walk({id='full',kind='ast_walk',scope='full-document'},function(doc)frag(pandoc.Pandoc(doc.blocks));frag(pandoc.Pandoc(doc.blocks));return doc end)
full(pandoc.Pandoc{pandoc.Para{pandoc.Str('x')}})
local child=m.wrap_sync({id='coroutine',kind='function'},function() coroutine.yield(4);return 9 end)
local c1=coroutine.create(child);local c2=coroutine.create(child)
assert(select(2,coroutine.resume(c1))==4);assert(select(2,coroutine.resume(c2))==4)
assert(select(2,coroutine.resume(c1))==9);assert(select(2,coroutine.resume(c2))==9)
a.flush();return {}`);
  const summary=result as {counters:Record<string,number>;data_valid:boolean;incomplete_spans:number};
  assert.equal(summary.counters["walk_api_calls.full-document"],1);assert.equal(summary.counters["walk_api_calls.fragment"],2);assert.equal(summary.counters["calls.coroutine"],2);assert.equal(summary.incomplete_spans,0);assert.equal(summary.data_valid,true);
});
Deno.test("Lua call/return hook traces selected module recursion and tail calls",async()=>{
  const {result}=await fixture(`local install=dofile(${JSON.stringify(project+"src/agents/lua/agent.lua")})
local a=install{experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='trace'}
a.start_trace({'fixture.lua'})
local function recur(n) if n==0 then return 0 end return recur(n-1) end
assert(recur(3)==0)
a.stop_trace();a.flush();return {}`,"trace");
  const s=result as {counters:Record<string,number>;incomplete_spans:number};
  assert(Object.keys(s.counters).some(k=>k.startsWith("calls.lua:")));assert.equal(s.incomplete_spans,0);
});
