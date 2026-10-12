import {strict as assert} from "node:assert";
import {executeScenario,cleanEnvironment} from "../../src/runner/execute.ts";
import type {Scenario,PreparedVariant} from "../../src/config/types.ts";
import {join} from "node:path";
Deno.test("off clears inherited diagnostics but retains functional course profile",()=>{
  const env=cleanEnvironment({COURSE_PERF_MODE:"trace",COURSE_BUILD_TRACE:"file",QUARTO_PROFILER_OUTPUT:"file",QUARTO_DENO:"launcher",QUARTO_PANDOC:"launcher",QUARTO_TS_PROFILE:"true",QUARTO_PROFILE:"student",FUNCTIONAL:"keep"});
  assert.deepEqual(env,{QUARTO_PROFILE:"student",FUNCTIONAL:"keep"});
});
Deno.test("runner keeps argv, cwd, outputs and build exit code and off creates no telemetry",async()=>{
  const root=await Deno.makeTempDir({prefix:"perf runner "});
  try {
    const path=join(root,"fake.ts");await Deno.writeTextFile(path,"console.log(JSON.stringify([Deno.args,Deno.cwd(),Deno.env.get('QUARTO_PROFILE'),Deno.env.get('COURSE_PERF_MODE')]));console.error('error-stream');Deno.exit(23);");
    const scenario:Scenario={id:"fake",project:"Java",cwd:".",executable:Deno.execPath(),args:["run","-A",path,"arg with spaces"],courseProfile:"student",cachePolicy:"repeat-render",mode:"off",scope:{modules:[],extensions:[],strict:true},resources:{wall:true,cpu:true,peakRss:true}};
    const prepared:PreparedVariant={variant:"candidate",root,manifest:{experimentId:"e",sources:[],packages:[],runtime:{}}};
    const result=await executeScenario(scenario,prepared,"off",{outputRoot:join(root,"runs"),env:{QUARTO_PROFILE:"student",COURSE_PERF_MODE:"trace"}});
    assert.equal(result.buildExitCode,23);assert.equal(result.dataValid,true);assert.equal(result.preparation.length,0);
    assert.deepEqual(JSON.parse(await Deno.readTextFile(join(result.outputDirectory,"stdout.log"))),[["arg with spaces"],root,"student",null]);
    assert.equal(await Deno.readTextFile(join(result.outputDirectory,"stderr.log")),"error-stream\n");assert(result.wallSeconds>0);
    await assert.rejects(()=>Deno.stat(join(result.outputDirectory,"events")),Deno.errors.NotFound);
  }finally{await Deno.remove(root,{recursive:true});}
});
