import { strict as assert } from "node:assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyTree } from "../../src/sources/snapshot.ts";

Deno.test("installed tree: spaces, foreign config, empty cache, offline render and TS trace", async () => {
  const temporary = await Deno.makeTempDir({ prefix: "perf installed " });
  try {
    const root = join(temporary, "app space # percent%"),
      source = fileURLToPath(new URL("../../", import.meta.url));
    for (const directory of ["src", "bridge"]) {
      await copyTree(join(source, directory), join(root, directory));
    }
    await Deno.mkdir(join(root, "docs"), { recursive: true });
    await Deno.copyFile(
      join(source, "docs/operation-registry.json"),
      join(root, "docs/operation-registry.json"),
    );
    for (const name of ["deno.json", "deno.lock"]) {
      await Deno.copyFile(join(source, name), join(root, name));
    }
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "tools/check-installed.ts", "--root", root],
      cwd: source,
      stdout: "piped",
      stderr: "piped",
    }).output();
    console.log(new TextDecoder().decode(output.stdout));
    assert.equal(
      output.code,
      0,
      new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr),
    );
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
});
