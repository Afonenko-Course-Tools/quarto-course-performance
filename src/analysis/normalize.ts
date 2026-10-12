import {join} from "node:path";
import {files} from "../sources/snapshot.ts";
import type {Event} from "../protocol/types.ts";
import {validateEvent} from "../protocol/validate.ts";
export interface QualitySummary {droppedEvents:number;incompleteSpans:number;coverageComplete:boolean;errors:string[]}
export interface NormalizedRun {runId:string;events:Event[];dataValid:boolean;quality:QualitySummary;executors:Record<string,Record<string,unknown>>}
export async function normalizeRun(directory:string):Promise<NormalizedRun> {
 const events:Event[]=[],quality:QualitySummary={droppedEvents:0,incompleteSpans:0,coverageComplete:true,errors:[]},executors:Record<string,Record<string,unknown>>={};let runId="";
 let entries:string[]=[];try{entries=await files(join(directory,"events"));}catch(e){quality.errors.push(`Журналы отсутствуют: ${String(e)}`);}
 let summaries=0;
 for(const path of entries) {
  if(path.endsWith(".summary.json")) {
   try{const s=JSON.parse(await Deno.readTextFile(path));summaries++;quality.droppedEvents+=s.dropped_events??0;quality.incompleteSpans+=s.incomplete_spans??0;quality.errors.push(...s.errors??[],...s.abi_failures??[]);if(!s.data_valid)quality.errors.push(`Невалидный executor ${path}`);executors[`${s.process_id}/${s.executor_id}`]=s;}catch(e){quality.errors.push(`Summary ${path}: ${String(e)}`);}
  }else if(path.endsWith(".jsonl")) {
   for(const line of (await Deno.readTextFile(path)).split("\n").filter(Boolean)) {
    try{const e=validateEvent(JSON.parse(line));if(runId&&e.run_id!==runId)throw new Error("Смешаны run_id");runId=e.run_id;events.push(e);}catch(e){quality.errors.push(`Event ${path}: ${String(e)}`);}
   }
  }
 }
 if(!summaries)quality.errors.push("Нет итогов executors");
 const sequence=new Map<string,number>(),open=new Map<string,Event>(),seen=new Set<string>();
 for(const e of events) {
  const key=`${e.process_id}/${e.executor_id}`,last=sequence.get(key)??0;
  if(e.sequence!==last+1)quality.errors.push(`Пропуск/повтор sequence: ${key} ${e.sequence}`);sequence.set(key,e.sequence);
  if(e.event==="begin") {if(seen.has(e.span_id!))quality.errors.push(`Повтор span ${e.span_id}`);seen.add(e.span_id!);open.set(e.span_id!,e);}
  if(e.event==="end") {
   const begin=open.get(e.span_id!);
   if(!begin||begin.executor_id!==e.executor_id||begin.process_id!==e.process_id||begin.clock_domain!==e.clock_domain||begin.operation_id!==e.operation_id||e.timestamp_us!<begin.timestamp_us!)quality.errors.push(`Несогласованный end ${e.span_id}`);
   else open.delete(e.span_id!);
  }
 }
 quality.incompleteSpans=Math.max(open.size,quality.incompleteSpans);
 for(const e of events)if(e.parent_span_id&&!seen.has(e.parent_span_id)) {
  const executor=executors[`${e.process_id}/${e.executor_id}`];
  if(executor?.parent_link!=="confirmed")quality.errors.push(`Неподтверждённый parent ${e.parent_span_id}`);
 }
 try{const c=JSON.parse(await Deno.readTextFile(join(directory,"coverage.json")));quality.coverageComplete=c.complete===true;}catch(e){if(!(e instanceof Deno.errors.NotFound))quality.errors.push(`Coverage: ${String(e)}`);}
 return {runId,events,dataValid:!quality.droppedEvents&&!quality.incompleteSpans&&!quality.errors.length,quality,executors};
}
