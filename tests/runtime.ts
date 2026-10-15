import { join } from "node:path";
const result = await new Deno.Command("quarto", {
  args: ["--paths"],
  stdout: "piped",
  stderr: "piped",
}).output();
if (!result.success) throw new Error("Для native fixtures нужен Quarto");
const [bin, share] = new TextDecoder().decode(result.stdout).trim().split("\n");
let selected = join(bin, "tools", Deno.build.arch, "pandoc");
try {
  await Deno.stat(selected);
} catch {
  selected = join(bin, "tools/pandoc");
}
export const pandoc = Deno.env.get("PERF_PANDOC") ?? selected;
export const dataDir = join(share, "pandoc/datadir");
