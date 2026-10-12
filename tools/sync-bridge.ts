import { join } from "node:path";
const project = new URL("../", import.meta.url).pathname;
export async function syncBridge(ownerRoots: string[], checkOnly: boolean) {
  for (const root of ownerRoots) {
    for await (const ext of Deno.readDir(join(root, "_extensions"))) {
      if (!ext.isDirectory) continue;
      const dest = join(root, "_extensions", ext.name, "observability");
      for (const language of ["ts", "lua"]) {
        const name = "bridge." + language,
          expected = await Deno.readTextFile(join(project, "bridge", name)),
          path = join(dest, name);
        if (checkOnly) {
          if (await Deno.readTextFile(path) !== expected) throw new Error(`ABI drift: ${path}`);
        } else {
          await Deno.mkdir(dest, { recursive: true });
          await Deno.writeTextFile(path, expected);
        }
      }
    }
  }
}
if (import.meta.main) {
  await syncBridge(Deno.args.filter((a) => a !== "--check"), Deno.args.includes("--check"));
}
