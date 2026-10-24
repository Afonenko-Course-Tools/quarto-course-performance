import { dataDir, pandoc } from "../runtime.ts";
import { strict as assert } from "node:assert";
import { join } from "node:path";
const project = new URL("../../", import.meta.url).pathname;

Deno.test("Pandoc picoseconds are converted to microseconds before arithmetic", async () => {
  const { events, stdout } = await fixture(
    `local agent=dofile(${
      JSON.stringify(project + "src/agents/lua/agent.lua")
    }){experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='summary'}
local before=os.clock();agent.metrics.wrap_sync({id='cpu',kind='phase'},function()for i=1,1000000 do math.sqrt(i)end end)();local elapsed=os.clock()-before
agent.flush();return {{Pandoc=function(doc)return pandoc.Pandoc{pandoc.Plain{pandoc.Str(tostring(elapsed))}}end}}`,
  );
  const begin = events.find((e) => e.event === "begin")!,
    end = events.find((e) => e.event === "end")!,
    ratio = (end.timestamp_us! - begin.timestamp_us!) / (Number(stdout.trim()) * 1000000);
  assert(ratio > .5 && ratio < 2, `CPU ratio=${ratio}`);
  assert(begin.timestamp_us! >= 0 && end.timestamp_us! < 1e12);
});
async function fixture(source: string, mode = "summary") {
  const root = await Deno.makeTempDir();
  try {
    const path = join(root, "fixture.lua");
    await Deno.writeTextFile(path, source);
    const out = await new Deno.Command(pandoc, {
      args: ["--lua-filter", path, "-t", "plain"],
      env: { COURSE_PERF_MODE: mode, COURSE_PERF_OUTPUT_DIR: root },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    let result: unknown;
    try {
      result = JSON.parse(await Deno.readTextFile(join(root, "events/p/lua.summary.json")));
    } catch {
      result = null;
    }
    let events: { event: string; status?: string; timestamp_us?: number }[] = [];
    try {
      events = (await Deno.readTextFile(join(root, "events/p/lua.jsonl"))).trim().split("\n")
        .filter(Boolean).map((line) => JSON.parse(line));
    } catch {}
    return { result, events, stdout: new TextDecoder().decode(out.stdout) };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
Deno.test("Lua off preserves identity, multiple nil returns and does not install hooks", async () => {
  await fixture(
    `local bridge=dofile(${JSON.stringify(project + "bridge/bridge.lua")})
local m=bridge.create_metrics('test',1)
local f=function() return 1,nil,3,nil end
assert(m.wrap_sync({id='n',kind='function'},f)==f)
assert(m.wrap_walk({id='w',kind='ast_walk',scope='fragment'},f)==f)
local env={x='y'}; assert(m.child_env(env)==env)
local a=table.pack(f()); assert(a.n==4 and a[3]==3 and a[4]==nil)
assert(debug.gethook()==nil)
return {}`,
    "off",
  );
});
Deno.test("Lua wrappers preserve nil/error identity and nested walk scopes across coroutines", async () => {
  const { result } = await fixture(
    `local install=dofile(${JSON.stringify(project + "src/agents/lua/agent.lua")})
local a=install{experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='summary'}
local m=dofile(${JSON.stringify(project + "bridge/bridge.lua")}).create_metrics('test',1)
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
a.flush();return {}`,
  );
  const summary = result as {
    counters: Record<string, number>;
    data_valid: boolean;
    incomplete_spans: number;
  };
  assert.equal(summary.counters["walk_api_calls.full-document"], 1);
  assert.equal(summary.counters["walk_api_calls.fragment"], 2);
  assert.equal(summary.counters["calls.coroutine"], 2);
  assert.equal(summary.incomplete_spans, 0);
  assert.equal(summary.data_valid, true);
});
Deno.test("Lua call/return hook traces selected module recursion and tail calls", async () => {
  const { result } = await fixture(
    `local install=dofile(${JSON.stringify(project + "src/agents/lua/agent.lua")})
local a=install{experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='trace'}
a.start_trace({debug.getinfo(1,'S').source})
local function recur(n) if n==0 then return 0 end return recur(n-1) end
assert(recur(3)==0)
a.stop_trace();a.flush();return {}`,
    "trace",
  );
  const s = result as { counters: Record<string, number>; incomplete_spans: number };
  assert(Object.keys(s.counters).some((k) => k.startsWith("calls.lua:")));
  assert.equal(s.incomplete_spans, 0);
});

Deno.test("Lua state finalizer flushes without calling Pandoc Haskell APIs", async () => {
  const { result } = await fixture(
    `local install=dofile(${JSON.stringify(project + "src/agents/lua/agent.lua")})
local agent=install{experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='summary'}
agent.metrics.wrap_sync({id='phase',kind='phase'},function()return 42 end)()
FINALIZER=setmetatable({}, {__gc=function()agent.shutdown()end})
return {}`,
  );
  assert.equal((result as { data_valid: boolean }).data_valid, true);
});

Deno.test("Lua hook unwinds caught callback errors without leaving successful or incomplete frames", async () => {
  const { result, events } = await fixture(
    `local agent=dofile(${
      JSON.stringify(project + "src/agents/lua/agent.lua")
    }){experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='trace'}
agent.start_trace({debug.getinfo(1,'S').source})
local err={bad=true};local function leaf()error(err)end;local function outer()leaf()end
local ok,value=pcall(outer);assert(not ok and value==err)
agent.stop_trace();agent.flush();return {}`,
    "trace",
  );
  assert.equal((result as { data_valid: boolean }).data_valid, true);
  assert(events.some((e) => e.status === "error"));
});

Deno.test("Lua coroutine factories inherit creator span and stop removes hooks from wrapped threads", async () => {
  const { events, result } = await fixture(`
local agent=dofile(${
    JSON.stringify(project + "src/agents/lua/agent.lua")
  }){experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='summary'}
local m=agent.metrics
local child=m.wrap_sync({id='child',kind='phase'},function()return 1,nil,3,nil end)
local outer=m.wrap_sync({id='outer',kind='phase'},function()
 local co=coroutine.create(child);local values=table.pack(coroutine.resume(co));assert(values.n==5 and values[2]==1 and values[4]==3)
 local wrapped=coroutine.wrap(child);values=table.pack(wrapped());assert(values.n==4 and values[1]==1 and values[3]==3)
end)
outer()
agent.start_trace({debug.getinfo(1,'S').source})
local wrapped=coroutine.wrap(function()coroutine.yield(7);return 8 end)
local _,thread=debug.getupvalue(wrapped,1)
assert(wrapped()==7)
agent.stop_trace();assert(debug.gethook(thread)==nil);assert(wrapped()==8)
agent.flush();return {}`);
  const all = events as Record<string, unknown>[];
  const outer = all.find((e) => e.event === "begin" && e.operation_id === "outer")!;
  const children = all.filter((e) => e.event === "begin" && e.operation_id === "child");
  assert.equal(children.length, 2);
  assert(children.every((e) => e.parent_span_id === outer.span_id));
  // Stopping a suspended observed function records an aborted span.
  assert((result as { incomplete_spans: number }).incomplete_spans > 0);
});

Deno.test("Lua tail caller remains the logical parent and inherits the callee failure", async () => {
  const { events, result } = await fixture(
    `
local agent=dofile(${
      JSON.stringify(project + "src/agents/lua/agent.lua")
    }){experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='trace'}
local err={tail=true}
local function leaf() error(err) end
local function outer() return leaf() end
agent.start_trace({debug.getinfo(1,'S').source})
local ok,value=pcall(outer);assert(not ok and value==err)
agent.stop_trace();agent.flush();return {}`,
    "trace",
  );
  const all = events as Record<string, unknown>[];
  const begins = all.filter((e) => e.event === "begin");
  assert.equal(begins.length, 2);
  assert.equal(begins[1].parent_span_id, begins[0].span_id);
  assert.equal(all.filter((e) => e.event === "end" && e.status === "error").length, 2);
  assert.equal((result as { data_valid: boolean }).data_valid, true);
});

Deno.test("Lua summary skips per-node handlers but keeps document phases and shortcode operations", async () => {
  const { result } = await fixture(`
local agent=dofile(${
    JSON.stringify(project + "src/agents/lua/agent.lua")
  }){experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='summary'}
local fn=function(x)return x end
assert(agent.metrics.wrap_sync({id='owner.filter.handler.Str',kind='function'},fn)==fn)
agent.metrics.wrap_sync({id='owner.filter.handler.Pandoc',kind='phase'},fn)(1)
agent.metrics.wrap_sync({id='course-navigation.shortcodes.handler.nav',kind='function'},fn)(2)
agent.flush();return {}`);
  const counters = (result as { counters: Record<string, number> }).counters;
  assert.equal(counters["calls.owner.filter.handler.Str"], undefined);
  assert.equal(counters["calls.owner.filter.handler.Pandoc"], 1);
  assert.equal(counters["calls.course-navigation.shortcodes.handler.nav"], 1);
});

Deno.test("Lua reads public document at call time and records facade extension without leaking context", async () => {
  const { events } = await fixture(`
local a=dofile(${
    JSON.stringify(project + "src/agents/lua/agent.lua")
  }){experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='summary'}
local m=dofile(${JSON.stringify(project + "bridge/bridge.lua")}).create_metrics('owner',1)
quarto={doc={input_file='before.qmd'}}
local spec={id='document',kind='phase',attributes={custom=7}}
local f=m.wrap_sync(spec,function()return 42 end)
quarto.doc.input_file='a.qmd';assert(f()==42)
quarto.doc.input_file='b.qmd';f()
quarto=nil;f()
a.metrics.wrap_sync({id='old-bridge',kind='phase'},function()end)()
assert(spec.attributes.extension_id==nil)
a.flush();return {}`);
  const all = events as unknown as Record<string, unknown>[];
  const begins = all.filter((e) => e.event === "begin");
  assert.deepEqual(begins.map((e) => e.document_id), ["a.qmd", "b.qmd", undefined, undefined]);
  assert.deepEqual(begins[0].attributes, { custom: 7, extension_id: "owner" });
  assert.equal(begins[3].attributes, undefined);
});
Deno.test("Lua trace excludes a substring match and accepts normalized file identity", async () => {
  const { events } = await fixture(
    `
local a=dofile(${
      JSON.stringify(project + "src/agents/lua/agent.lua")
    }){experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='trace'}
local source=debug.getinfo(1,'S').source
local sibling=assert(load('return function() return 9 end',source..'.other'))()
local own=assert(load('return function() return 7 end',source))()
a.start_trace({(source:gsub('fixture.lua$','./fixture.lua'))})
assert(sibling()==9);assert(own()==7)
a.stop_trace();a.flush();return {}`,
    "trace",
  );
  const begins = events.filter((e) => e.event === "begin");
  assert.equal(begins.length, 1);
});

Deno.test("Lua ABI 1 newer facade tolerates older metrics and full child env removes a ghost parent", async () => {
  await fixture(`
local seen
local wrap=function(spec,fn)seen=spec;return fn end
__course_performance_agent_v1={abiVersion=1,metrics={wrap_sync=wrap,wrap_walk=wrap,child_env=function(base)return base end}}
local m=dofile(${JSON.stringify(project + "bridge/bridge.lua")}).create_metrics('legacy',1)
assert(m.wrap_sync({id='old',kind='phase'},function()return 7 end)()==7)
assert(seen.attributes.extension_id=='legacy')
local a=dofile(${
    JSON.stringify(project + "src/agents/lua/agent.lua")
  }){experimentId='e',runId='r',processId='current',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='summary'}
local env=pandoc.system.environment();env.COURSE_PERF_PARENT_SPAN_ID='stale';env.FUNCTIONAL='yes'
pandoc.system.with_environment(env,function()
 local full=pandoc.system.environment();local child=a.metrics.child_env(full)
 assert(full.COURSE_PERF_PARENT_SPAN_ID=='stale');assert(child.COURSE_PERF_PARENT_PROCESS_ID=='current')
 pandoc.system.with_environment(child,function()assert(os.getenv('COURSE_PERF_PARENT_SPAN_ID')==nil);assert(os.getenv('FUNCTIONAL')=='yes')end)
 assert(os.getenv('COURSE_PERF_PARENT_SPAN_ID')=='stale')
end)
return {}`);
});
Deno.test("Lua suspended document calls retain the document seen on each call", async () => {
  const { events } = await fixture(`
local a=dofile(${
    JSON.stringify(project + "src/agents/lua/agent.lua")
  }){experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='summary'}
local m=dofile(${JSON.stringify(project + "bridge/bridge.lua")}).create_metrics('owner',1)
quarto={doc={}}
local f=m.wrap_sync({id='phase',kind='phase'},function()coroutine.yield();return 42 end)
local a1,a2=coroutine.create(f),coroutine.create(f)
quarto.doc.input_file='a.qmd';assert(coroutine.resume(a1))
quarto.doc.input_file='b.qmd';assert(coroutine.resume(a2))
quarto.doc.input_file=nil;assert(coroutine.resume(a1));assert(coroutine.resume(a2))
a.flush();return {}`);
  const all = events as unknown as Record<string, unknown>[];
  assert.deepEqual(all.map((e) => [e.event, e.document_id]), [
    ["begin", "a.qmd"],
    ["begin", "b.qmd"],
    ["end", "a.qmd"],
    ["end", "b.qmd"],
  ]);
});
Deno.test("Lua walk deltas and trace callbacks retain recorded extension and public document", async () => {
  const { events } = await fixture(
    `
local a=dofile(${
      JSON.stringify(project + "src/agents/lua/agent.lua")
    }){experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=os.getenv('COURSE_PERF_OUTPUT_DIR'),mode='trace'}
local m=dofile(${JSON.stringify(project + "bridge/bridge.lua")}).create_metrics('owner',1)
quarto={doc={input_file='doc.qmd'}}
local walk=m.wrap_walk({id='walk',kind='ast_walk',scope='fragment'},function(doc,filter)return doc:walk(filter)end)
walk(pandoc.Pandoc{pandoc.Para{pandoc.Str('x')}},{Str=function(s)return s end})
a.flush();return {}`,
    "trace",
  );
  const all = events as unknown as Record<string, unknown>[];
  assert.equal(all.length, 5);
  for (const e of all) {
    assert.equal(e.document_id, "doc.qmd");
    assert.equal((e.attributes as Record<string, unknown>).extension_id, "owner");
  }
});
