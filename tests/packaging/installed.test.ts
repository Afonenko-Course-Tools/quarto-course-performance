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
    const archives = Deno.env.get("PERF_NPM_ARCHIVES");
    if (archives) {
      for (const [name, version] of [["typescript", "5.9.3"], ["luaparse", "0.3.1"]]) {
        const target = join(root, "node_modules", name);
        await Deno.mkdir(target, { recursive: true });
        const extracted = await new Deno.Command("tar", {
          args: [
            "-xzf",
            join(archives, `${name}-${version}.tgz`),
            "--strip-components=1",
            "-C",
            target,
          ],
        }).output();
        assert(extracted.success, new TextDecoder().decode(extracted.stderr));
      }
    } else {await copyTree(join(source, "node_modules"), join(root, "node_modules"), {
        materializeFileLinks: true,
      });}
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
