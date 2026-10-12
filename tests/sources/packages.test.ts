import { strict as assert } from "node:assert";
import { join } from "node:path";
import { installPackages } from "../../src/sources/packages.ts";

Deno.test("installs_all_subproject_copies and records identical owner hashes", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf packages " });
  try {
    const owner = join(root, "owner/_extensions/core");
    await Deno.mkdir(owner, { recursive: true });
    await Deno.writeTextFile(join(owner, "_extension.yml"), "version: 1\n");
    await Deno.writeTextFile(join(owner, "filter.lua"), "return {}\n");
    const course = join(root, "course");
    for (const prefix of ["", "child one/", "child two/"]) {
      const path = join(course, prefix, "_extensions/org/core");
      await Deno.mkdir(path, { recursive: true });
      await Deno.writeTextFile(join(path, "_extension.yml"), "version: old\n");
    }
    const receipts = await installPackages(course, [{ repository: "org/owner", sha: "a".repeat(40), checkoutPath: join(root, "owner") }]);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].destinationPaths.length, 3);
    assert.match(receipts[0].packageHash, /^[0-9a-f]{64}$/);
    for (const dest of receipts[0].destinationPaths) {
      assert.equal(await Deno.readTextFile(join(dest, "filter.lua")), "return {}\n");
    }
  } finally { await Deno.remove(root, { recursive: true }); }
});

Deno.test("rejects symlink escape before replacing any installation", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root,"owner/_extensions/core"), { recursive: true });
    await Deno.writeTextFile(join(root,"owner/_extensions/core/_extension.yml"), "version: 1");
    await Deno.mkdir(join(root,"outside/org/core"), { recursive: true });
    await Deno.writeTextFile(join(root,"outside/org/core/_extension.yml"), "original");
    await Deno.mkdir(join(root,"course"));
    await Deno.symlink(join(root,"outside"), join(root,"course/_extensions"));
    await assert.rejects(() => installPackages(join(root,"course"), [{repository:"org/owner",sha:"a".repeat(40),checkoutPath:join(root,"owner")}]), /symlink|символическ/i);
    assert.equal(await Deno.readTextFile(join(root,"outside/org/core/_extension.yml")), "original");
  } finally { await Deno.remove(root, {recursive: true}); }
});
