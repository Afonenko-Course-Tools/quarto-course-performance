import { strict as assert } from "node:assert";
import { createMetrics } from "../../bridge/bridge.ts";
import { installTsAgent } from "../../src/agents/ts/agent.ts";
import { prepareTsBootstrap } from "../../src/launchers/prepare.ts";
import { join } from "node:path";

Deno.test("recursive sync spans preserve this and original errors",async()=>{
  const root=await Deno.makeTempDir(); Deno.env.set("COURSE_PERF_MODE","summary");
  try {
    const agent=installTsAgent({experimentId:"e",runId:"r",processId:"p",outputDirectory:root,mode:"summary"}); const m=createMetrics("test");
    const err={code:42}, obj={value:3, fn:m.wrapSync({id:"method",kind:"phase"},function(this:{value:number},n:number){if(n===0)throw err;return this.value+n;})};
    assert.equal(obj.fn(4),7); assert.throws(()=>obj.fn(0),e=>e===err);
    const recur=m.wrapSync({id:"recursive",kind:"function"},(n:number):number=>n?recur(n-1)+1:0); assert.equal(recur(2),2);
    const events=agent.events; const nested=events.filter(e=>e.event==="begin" && e.operation_id==="recursive");
    assert.equal(nested[1].parent_span_id,nested[0].span_id); assert.equal(nested[2].parent_span_id,nested[1].span_id);
    assert.equal(events.filter(e=>e.status==="error").length,1); agent.flush();
  } finally { Deno.env.delete("COURSE_PERF_MODE"); Reflect.deleteProperty(globalThis,Symbol.for("course.performance.agent.v1")); await Deno.remove(root,{recursive:true}); }
});

Deno.test("parallel async branches retain distinct parents and rejection identity",async()=>{
  const root=await Deno.makeTempDir(); Deno.env.set("COURSE_PERF_MODE","summary");
  try {
    const agent=installTsAgent({experimentId:"e",runId:"r",processId:"p",outputDirectory:root,mode:"summary"}); const m=createMetrics("test");
    const leaf=m.wrapAsync({id:"leaf",kind:"function"},async(n:number)=>{await new Promise(r=>setTimeout(r,n));return n;});
    const branch=m.wrapAsync({id:"branch",kind:"phase"},async(n:number)=>await leaf(n));
    assert.deepEqual(await Promise.all([branch(15),branch(1)]),[15,1]);
    const starts=agent.events.filter(e=>e.event==="begin"), branches=starts.filter(e=>e.operation_id==="branch"), leaves=starts.filter(e=>e.operation_id==="leaf");
    assert.notEqual(leaves[0].parent_span_id,leaves[1].parent_span_id); assert.deepEqual(leaves.map(e=>e.parent_span_id),branches.map(e=>e.span_id));
    const error={bad:true}, bad=m.wrapAsync({id:"bad",kind:"function"},()=>Promise.reject(error)); await assert.rejects(bad, e=>e===error);
    agent.flush();
  } finally { Deno.env.delete("COURSE_PERF_MODE"); Reflect.deleteProperty(globalThis,Symbol.for("course.performance.agent.v1")); await Deno.remove(root,{recursive:true}); }
});

Deno.test("bounded writer reports dropped events but keeps exact operation counters",async()=>{
  const root=await Deno.makeTempDir();
  try {
    const agent=installTsAgent({experimentId:"e",runId:"r",processId:"p",outputDirectory:root,mode:"trace",maxEvents:2}); const fn=agent.metrics.wrapSync({id:"n",kind:"function"},()=>2);
    for(let n=0;n<5;n++) assert.equal(fn(),2);
    agent.flush(); const summary=JSON.parse(await Deno.readTextFile(join(root,"events/p/ts.summary.json")));
    assert.equal(summary.counters["calls.n"],5); assert(summary.dropped_events>0); assert.equal(summary.data_valid,false);
  }finally{Reflect.deleteProperty(globalThis,Symbol.for("course.performance.agent.v1"));await Deno.remove(root,{recursive:true});}
});

Deno.test("bootstrap preserves import.meta.main, shebang, args and relative imports",async()=>{
  const root=await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(root,"bootstrap.ts"),"globalThis.__probe = true;\n");
    await Deno.writeTextFile(join(root,"local.ts"),"export const local=7;\n");
    const path=join(root,"entry.ts"); await Deno.writeTextFile(path,"#!/usr/bin/env deno\nimport {local} from './local.ts';\nif(import.meta.main) console.log(JSON.stringify([local,Deno.args,globalThis.__probe]));\n");
    const receipt=await prepareTsBootstrap(path,join(root,"bootstrap.ts")); assert.notEqual(receipt.sourceHash,receipt.preparedHash);
    const out=await new Deno.Command(Deno.execPath(),{args:["run","--no-check",path,"arg with spaces"],stdout:"piped",stderr:"piped"}).output();
    assert(out.success,new TextDecoder().decode(out.stderr)); assert.deepEqual(JSON.parse(new TextDecoder().decode(out.stdout)),[7,["arg with spaces"],true]);
  }finally{await Deno.remove(root,{recursive:true});}
});
