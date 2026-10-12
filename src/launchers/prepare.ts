import { pathToFileURL } from "node:url";
import { hashFile } from "../sources/snapshot.ts";
import type { PreparationReceipt } from "../config/types.ts";
export async function prepareTsBootstrap(
  entrypointPath: string,
  bootstrapPath: string,
): Promise<PreparationReceipt> {
  const sourceHash = await hashFile(entrypointPath),
    source = await Deno.readTextFile(entrypointPath);
  const line = `import ${JSON.stringify(pathToFileURL(bootstrapPath).href)};\n`;
  const offset = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
  await Deno.writeTextFile(entrypointPath, source.slice(0, offset) + line + source.slice(offset));
  return {
    kind: "bootstrap",
    path: entrypointPath,
    sourceHash,
    preparedHash: await hashFile(entrypointPath),
  };
}
