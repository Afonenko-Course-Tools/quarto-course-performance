import type {Scenario,PreparedVariant} from "../config/types.ts";
import { executeScenario, type ExecuteOptions } from "./execute.ts";
export async function benchmarkPair(scenario:Scenario,left:PreparedVariant,right:PreparedVariant,options:{pairs:number;seed:number;executeOptions?:ExecuteOptions}) {
  if(options.pairs<1 || !Number.isInteger(options.pairs)) throw new Error("Число пар должно быть положительным");
  for(const prepared of [left,right]) {const warm=await executeScenario(scenario,prepared,"off",options.executeOptions);if(warm.buildExitCode)throw new Error(`Прогрев завершился с кодом ${warm.buildExitCode}`);}
  const pairs=[];
  for(let i=0;i<options.pairs;i++) {
    const order=i%2?"BA" as const:"AB" as const,results=[];
    for(const prepared of order==="AB"?[left,right]:[right,left]) {
      const result=await executeScenario(scenario,prepared,"off",options.executeOptions);
      if(result.buildExitCode)throw new Error(`Benchmark build failed: ${result.outputDirectory}`);results.push(result);
    }
    const [a,b]=order==="AB"?results:results.toReversed();pairs.push({order,controlWall:a.wallSeconds,candidateWall:b.wallSeconds,controlRunId:a.runId,candidateRunId:b.runId});
  }
  return {pairs,seed:options.seed};
}
