import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import type { Mode } from "../../config/types.ts";
import type { Event, Metrics, OperationSpec, WalkSpec } from "../../protocol/types.ts";
export interface AgentConfig {experimentId:string;runId:string;processId:string;outputDirectory:string;mode:Mode;maxEvents?:number;executorId?:string}
export function installTsAgent(config: AgentConfig) {
  const registry=globalThis as unknown as Record<symbol,unknown>;
  const context=new AsyncLocalStorage<string>(); const events:Event[]=[]; const counters:Record<string,number>={};
  const active=new Set<string>(); const errors:string[]=[];
  let sequence=0,serial=0,dropped=0;
  const executorId=config.executorId??"ts";
  const timestamp=()=>performance.now()*1000;
  function emit(event:Omit<Event,"schema_version"|"experiment_id"|"run_id"|"process_id"|"executor_id"|"sequence">) {
    try {
      const row:Event={schema_version:1,experiment_id:config.experimentId,run_id:config.runId,process_id:config.processId,executor_id:executorId,sequence:++sequence,...event};
      if(events.length<(config.maxEvents??200000)) events.push(row); else dropped++;
    }catch(e){errors.push(String(e));}
  }
  function begin(spec:OperationSpec) {
    const id=`${config.processId}-${executorId}-${++serial}`;
    const parent=context.getStore()??Deno.env.get("COURSE_PERF_PARENT_SPAN_ID");
    counters[`calls.${spec.id}`]=(counters[`calls.${spec.id}`]??0)+1;
    if(spec.kind==="ast_walk") {
      const key=`walk_api_calls.${(spec as WalkSpec).scope}`; counters[key]=(counters[key]??0)+1;
      emit({event:"counter",kind:"ast_walk",origin:spec.origin??"manual",clock_domain:"none",counter:{name:key,value:1,quality:"observed-exact"}});
    }
    active.add(id);
    emit({event:"begin",kind:spec.kind,span_id:id,parent_span_id:parent,operation_id:spec.id,symbol_id:spec.symbol_id,origin:spec.origin??"manual",clock_domain:"monotonic_process",timestamp_us:timestamp()}); return id;
  }
  function end(id:string,spec:OperationSpec,status:"ok"|"error") {
    active.delete(id); emit({event:"end",kind:spec.kind,span_id:id,operation_id:spec.id,origin:spec.origin??"manual",clock_domain:"monotonic_process",timestamp_us:timestamp(),status});
  }
  // deno-lint-ignore no-explicit-any
  type Fn=(...args:any[])=>any;
  function wrapSync<T extends Fn>(spec:OperationSpec,fn:T):T {
    return function(this:unknown,...args:unknown[]) {
      const id=begin(spec); return context.run(id,()=>{try {const value=fn.apply(this,args);end(id,spec,"ok");return value;}catch(error){end(id,spec,"error");throw error;}});
    } as T;
  }
  function wrapAsync<T extends Fn>(spec:OperationSpec,fn:T):T {
    return function(this:unknown,...args:unknown[]) {
      const id=begin(spec); return context.run(id,async()=>{try {const value=await fn.apply(this,args);end(id,spec,"ok");return value;}catch(error){end(id,spec,"error");throw error;}});
    } as T;
  }
  const metrics:Metrics={wrapSync,wrapAsync,wrapWalk:wrapSync,childEnv(base){return {...base,COURSE_PERF_PARENT_PROCESS_ID:config.processId,...(context.getStore()?{COURSE_PERF_PARENT_SPAN_ID:context.getStore()!}:{})};}};
  const calibration={time_origin_ms:performance.timeOrigin,wall_epoch_ms:Date.now(),monotonic_us:timestamp(),uncertainty_us:1000};
  function flush() {
    const failures=(registry[Symbol.for("course.performance.failures.v1")]??[]) as string[];
    try {
      const dir=join(config.outputDirectory,"events",config.processId); Deno.mkdirSync(dir,{recursive:true});
      Deno.writeTextFileSync(join(dir,`${executorId}.jsonl`),events.map(e=>JSON.stringify(e)).join("\n")+(events.length?"\n":""));
      Deno.writeTextFileSync(join(dir,`${executorId}.summary.json`),JSON.stringify({schema_version:1,experiment_id:config.experimentId,run_id:config.runId,process_id:config.processId,executor_id:executorId,os_pid:Deno.pid,parent_process_id:Deno.env.get("COURSE_PERF_PARENT_PROCESS_ID")??null,parent_link:Deno.env.get("COURSE_PERF_PARENT_PROCESS_ID")?"confirmed":"unlinked",clock_domain:"monotonic_process",calibration,counters,dropped_events:dropped,incomplete_spans:active.size,errors:[...errors,...failures],data_valid:!dropped&&!active.size&&!errors.length&&!failures.length}));
    }catch(e){errors.push(`flush: ${String(e)}`);}
  }
  const agent={abiVersion:1,metrics,events,flush}; registry[Symbol.for("course.performance.agent.v1")]=agent; return agent;
}
