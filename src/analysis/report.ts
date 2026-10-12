import {join} from "node:path";
import type {SourceManifest} from "../config/types.ts";
import type {NormalizedRun} from "./normalize.ts";
import {traces} from "../report/perfetto.ts";
export async function writeExperimentReport(manifest:SourceManifest,runs:NormalizedRun[],output:string) {
 await Deno.mkdir(output,{recursive:true});
 const summary=runs.map(run=>({run_id:run.runId,data_valid:run.dataValid,events:run.events.length,quality:run.quality,counters:Object.values(run.executors).map(e=>({process_id:e.process_id,executor_id:e.executor_id,clock_domain:e.clock_domain,counters:e.counters,node_visits:null}))}));
 await Deno.writeTextFile(join(output,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");await Deno.writeTextFile(join(output,"summary.json"),JSON.stringify(summary,null,2)+"\n");
 await Deno.writeTextFile(join(output,"quality.json"),JSON.stringify(runs.map(r=>({run_id:r.runId,...r.quality})),null,2)+"\n");
 for(const run of runs) {const path=join(output,"runs",run.runId);await Deno.mkdir(path,{recursive:true});const trace=traces(run);await Deno.writeTextFile(join(path,"wall.trace.json"),JSON.stringify(trace.wall));await Deno.writeTextFile(join(path,"lua-cpu.trace.json"),JSON.stringify(trace.luaCpu));}
 const lines=["# Отчёт Performance","",`Эксперимент: \`${manifest.experimentId}\`.`,"","Время TypeScript — wall, Lua — CPU процесса. Шкалы раздельны; inclusive интервалы не суммируются. Self time async и node_visits недоступны без отдельных наблюдений.","","| Запуск | Данные | События | Потери | Незавершённые интервалы |","| --- | --- | ---: | ---: | ---: |",...runs.map(r=>`| ${r.runId} | ${r.dataValid?"VALID":"INVALID"} | ${r.events.length} | ${r.quality.droppedEvents} | ${r.quality.incompleteSpans} |`),"","## Источники","",...manifest.sources.map(s=>`- ${s.repository}: \`${s.remoteRef}\`, \`${s.sha}\`.`),"","Lua sampling backend: unavailable. CPU samples не являются точными счётчиками вызовов."];
 await Deno.writeTextFile(join(output,"report.md"),lines.join("\n")+"\n");
}
