import { strict as assert } from "node:assert";
import { join } from "node:path";

Deno.test("capabilities needs no Compiler API or npm cache", async () => {
  const root = await Deno.makeTempDir();
  try {
    const project = new URL("../../", import.meta.url).pathname;
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--cached-only", "-A", "src/cli.ts", "capabilities"],
      cwd: project,
      env: { DENO_DIR: join(root, "cache") },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    const capabilities = JSON.parse(new TextDecoder().decode(out.stdout));
    assert(capabilities.runtime.quarto.version);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
