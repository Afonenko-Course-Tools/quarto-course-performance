import { join, resolve, relative } from "node:path";
import type {Scenario,PreparedVariant,Mode,RunResult,PreparationReceipt} from "../config/types.ts";
import { contained } from "../sources/snapshot.ts";
export function cleanEnvironment(base:Record<string,string>):Record<string,string> {
  const result={...base};
  for(const key of Object.keys(result)) if(key.startsWith("COURSE_PERF_") || ["COURSE_BUILD_TRACE","QUARTO_REPORT_PERFORMANCE_METRICS","QUARTO_REPORT_PERFORMANCE_METRICS_FILE","QUARTO_PROFILER_OUTPUT","QUARTO_COMBINED_LUA_PROFILE","QUARTO_TS_PROFILE","QUARTO_DENO","QUARTO_PANDOC","QUARTO_DENO_EXTRA_OPTIONS","QUARTO_DENO_V8_OPTIONS"].includes(key)) delete result[key];
  return result;
}
export interface ExecuteOptions {outputRoot?:string;env?:Record<string,string>; preparation?:PreparationReceipt[];diagnosticEnv?:Record<string,string>;cleanPaths?:string[]}
export async function executeScenario(scenario:Scenario,prepared:PreparedVariant,mode:Mode,options:ExecuteOptions={}):Promise<RunResult> {
  const root=await Deno.realPath(prepared.root),cwd=resolve(root,scenario.cwd);await contained(root,cwd);
  if(scenario.cachePolicy==="clean-output") for(const path of options.cleanPaths??[]) {
    const target=resolve(root,path),rel=relative(root,target);if(!rel || rel===".." || rel.startsWith("../"))throw new Error("Недопустимый output path");
    try{await contained(root,target);await Deno.remove(target,{recursive:true});}catch(e){if(!(e instanceof Deno.errors.NotFound))throw e;}
  }
  const runId=crypto.randomUUID(),outputDirectory=join(options.outputRoot??"evidence/runs",runId);await Deno.mkdir(outputDirectory,{recursive:true});
  const env=cleanEnvironment({...Deno.env.toObject(),...options.env});
  if(mode!=="off")Object.assign(env,options.diagnosticEnv,{COURSE_PERF_MODE:mode,COURSE_PERF_EXPERIMENT_ID:prepared.manifest.experimentId,COURSE_PERF_RUN_ID:runId,COURSE_PERF_OUTPUT_DIR:resolve(outputDirectory)});
  const resourcesPath=join(outputDirectory,"resources.txt");let useTime=false;
  try{useTime=(await Deno.stat("/usr/bin/time")).isFile && (scenario.resources.cpu||scenario.resources.peakRss);}catch{/* Недоступные ресурсы остаются null. */}
  const executable=useTime?"/usr/bin/time":scenario.executable;
  const args=useTime?["-f","%U %S %M","-o",resolve(resourcesPath),"--",scenario.executable,...scenario.args]:scenario.args;
  const start=performance.now();
  const out=await new Deno.Command(executable,{args,cwd,env,clearEnv:true,stdin:"inherit",stdout:"piped",stderr:"piped"}).output();
  const wallSeconds=(performance.now()-start)/1000;
  await Deno.writeFile(join(outputDirectory,"stdout.log"),out.stdout);await Deno.writeFile(join(outputDirectory,"stderr.log"),out.stderr);
  let resources:{cpu_user_seconds:number|null;cpu_system_seconds:number|null;peak_rss_kib:number|null}={cpu_user_seconds:null,cpu_system_seconds:null,peak_rss_kib:null};
  if(useTime){const line=(await Deno.readTextFile(resourcesPath)).trim().split("\n").at(-1)!;const [user,system,rss]=line.split(" ").map(Number);if([user,system,rss].every(Number.isFinite))resources={cpu_user_seconds:user,cpu_system_seconds:system,peak_rss_kib:rss};}
  let dataValid=mode==="off";
  if(mode!=="off") {
    const {normalizeRun}=await import("../analysis/normalize.ts");const normalized=await normalizeRun(outputDirectory);dataValid=normalized.dataValid;
  }
  const result:RunResult={runId,buildExitCode:out.code,dataValid,outputDirectory,preparation:mode==="off"?[]:options.preparation??[],wallSeconds,signal:out.signal};
  await Deno.writeTextFile(join(outputDirectory,"run.json"),JSON.stringify({...result,scenario:scenario.id,variant:prepared.variant,mode,argv:[scenario.executable,...scenario.args],cwd,cachePolicy:scenario.cachePolicy,courseProfile:scenario.courseProfile,experimentId:prepared.manifest.experimentId,resources},null,2)+"\n");return result;
}
