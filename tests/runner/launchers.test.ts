import {strict as assert} from "node:assert";
import {join} from "node:path";
import {prepareLaunchers} from "../../src/launchers/setup.ts";
Deno.test("Deno launcher uses real binary, preserves main and args, and flushes on Deno.exit",async()=>{
 const root=await Deno.makeTempDir({prefix:"perf launch "});
 try{
  const setup=await prepareLaunchers({workspace:root,deno:Deno.execPath(),pandoc:"/opt/quarto/bin/tools/pandoc",dataDir:"/opt/quarto/share/pandoc/datadir"});
  const path=join(root,"entry.ts");await Deno.writeTextFile(path,"if(import.meta.main)console.log(JSON.stringify(Deno.args));Deno.exit(23);");
  const out=await new Deno.Command(setup.env.QUARTO_DENO,{args:["run","-A",path,"arg space"],env:{...setup.env,COURSE_PERF_MODE:"summary",COURSE_PERF_EXPERIMENT_ID:"e",COURSE_PERF_RUN_ID:"r",COURSE_PERF_OUTPUT_DIR:root},stdout:"piped",stderr:"piped"}).output();
  assert.equal(out.code,23,new TextDecoder().decode(out.stderr));assert.deepEqual(JSON.parse(new TextDecoder().decode(out.stdout)),["arg space"]);
  const dirs=[];for await(const dir of Deno.readDir(join(root,"events")))dirs.push(dir.name);assert.equal(dirs.length,1);
  const summary=JSON.parse(await Deno.readTextFile(join(root,"events",dirs[0],"ts.summary.json")));assert.equal(summary.run_id,"r");assert(summary.data_valid);
 }finally{await Deno.remove(root,{recursive:true});}
});
Deno.test("Lua data-dir bootstrap preserves original initialization and installs one agent in the shared state of two filter files",async()=>{
 const root=await Deno.makeTempDir();
 try{
  const data=join(root,"original-data");await Deno.mkdir(data);await Deno.writeTextFile(join(data,"init.lua"),"ORIGINAL_INIT_VALUE=7\n");
  const setup=await prepareLaunchers({workspace:root,deno:Deno.execPath(),pandoc:"/opt/quarto/bin/tools/pandoc",dataDir:data});
  for(const name of ["a","b"])await Deno.writeTextFile(join(root,name+".lua"),"assert(ORIGINAL_INIT_VALUE==7);assert(__course_performance_agent_v1);return {}\n");
  const out=await new Deno.Command(setup.env.QUARTO_PANDOC,{args:["--lua-filter",join(root,"a.lua"),"--lua-filter",join(root,"b.lua"),"-t","plain"],env:{...setup.env,COURSE_PERF_MODE:"summary",COURSE_PERF_EXPERIMENT_ID:"e",COURSE_PERF_RUN_ID:"r",COURSE_PERF_OUTPUT_DIR:root},stdin:"null",stdout:"piped",stderr:"piped"}).output();
  assert(out.success,new TextDecoder().decode(out.stderr));
  let summaries=0;for await(const dir of Deno.readDir(join(root,"events")))for await(const file of Deno.readDir(join(root,"events",dir.name)))if(file.name.endsWith('.summary.json'))summaries++;
  assert.equal(summaries,1);
 }finally{await Deno.remove(root,{recursive:true});}
});
