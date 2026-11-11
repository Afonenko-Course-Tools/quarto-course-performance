import { pathToFileURL } from "node:url";
import type { PreparedScript } from "../config/types.ts";
export async function prepareTsBootstrap(
  entrypointPath: string,
  bootstrapPath: string,
): Promise<PreparedScript> {
  const source = await Deno.readTextFile(entrypointPath);
  const line = `import ${JSON.stringify(pathToFileURL(bootstrapPath).href)};\n`;
  const offset = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
  await Deno.writeTextFile(entrypointPath, source.slice(0, offset) + line + source.slice(offset));
  return {
    kind: "bootstrap",
    path: entrypointPath,
  };
}
