import { join } from "node:path";
import { copyTree, hashFile } from "../../sources/snapshot.ts";
import type { PreparationReceipt } from "../../config/types.ts";
export async function prepareFilterAdapter(
  share: string,
  destination: string,
): Promise<PreparationReceipt> {
  await copyTree(share, destination, { materializeFileLinks: true });
  const main = join(destination, "filters/main.lua"),
    sourceHash = await hashFile(main),
    source = await Deno.readTextFile(main);
  const marker = "_quarto.ast = {";
  if (
    !source.includes("function run_emulated_filter(doc, filter, traverser)") ||
    source.split(marker).length !== 2
  ) throw new Error("Unsupported Quarto filter adapter");
  const patch =
    `-- Performance: только диагностическая копия runtime.\nlocal __perfAgent=rawget(_G,'__course_performance_agent_v1')\nif __perfAgent then\n local __perfOriginal=run_emulated_filter\n local __perfObserved=__perfAgent.metrics.wrap_sync({id='quarto.filter.run',kind='phase',origin='runtime'},__perfOriginal)\n run_emulated_filter=function(doc,filter,traverser)\n  if doc==nil or (type(filter)=='table' and next(filter)==nil) then return __perfOriginal(doc,filter,traverser) end\n  return __perfObserved(doc,filter,traverser)\n end\nend\n\n`;
  await Deno.writeTextFile(main, source.replace(marker, patch + marker));
  return { kind: "quarto-adapter", path: main, sourceHash, preparedHash: await hashFile(main) };
}
