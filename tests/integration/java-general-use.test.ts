import { strict as assert } from "node:assert";
import { join } from "node:path";

Deno.test("Java output gate rejects changed HTML, ZIP and unexpected dynamic paths", async () => {
  const modulePath = "../../tools/check-java-general-use.ts";
  const module = await import(modulePath).catch(() => undefined);
  assert(module, "Java general-use gate отсутствует");
  const root = await Deno.makeTempDir();
  try {
    for (const side of ["a", "b"]) {
      await Deno.mkdir(join(root, side));
      await Deno.writeTextFile(join(root, side, "index.html"), "<p>content</p>");
      await Deno.writeFile(join(root, side, "starter.zip"), new Uint8Array([80, 75, 1]));
      await Deno.writeTextFile(join(root, side, "sitemap.xml"), side);
    }
    const compare = () =>
      module.compareStrictTrees(join(root, "a"), join(root, "b"), ["sitemap.xml"]);
    const initial = await compare();
    assert.equal(initial.equivalent, true);
    assert(initial.leftFiles && initial.rightFiles, "Successful output hashes must be retained");
    assert.equal(initial.leftFiles["index.html"], initial.rightFiles["index.html"]);
    assert.match(initial.leftFiles["starter.zip"], /^[0-9a-f]{64}$/);
    await Deno.writeTextFile(join(root, "b/index.html"), "<p>different content</p>");
    assert.deepEqual((await compare()).differences.map((d: { path: string }) => d.path), [
      "index.html",
    ]);
    await Deno.copyFile(join(root, "a/index.html"), join(root, "b/index.html"));
    await Deno.writeFile(join(root, "b/starter.zip"), new Uint8Array([80, 75, 2]));
    assert.equal((await compare()).equivalent, false);
    await Deno.copyFile(join(root, "a/starter.zip"), join(root, "b/starter.zip"));
    await Deno.writeTextFile(join(root, "b/unexpected.json"), "{}");
    assert.equal((await compare()).equivalent, false);
    await assert.rejects(() =>
      module.compareStrictTrees(join(root, "a"), join(root, "b"), ["*.html"])
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
