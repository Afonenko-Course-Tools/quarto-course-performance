import { strict as assert } from "node:assert";
import { join } from "node:path";
import { copyTree, files } from "../../src/sources/files.ts";

Deno.test("prepared copies retain input mtime used by Quarto sitemap lastmod", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf source times " });
  try {
    const source = join(root, "source");
    await Deno.mkdir(join(source, "nested"), { recursive: true });
    const inputs = [
      { path: "index.qmd", text: "# Курс\n", mtime: "2001-02-03T04:05:06.000Z" },
      { path: "nested/chapter.qmd", text: "# Глава\n", mtime: "2002-03-04T05:06:07.000Z" },
    ];
    for (const input of inputs) {
      const file = join(source, input.path);
      await Deno.writeTextFile(file, input.text);
      const mtime = new Date(input.mtime);
      await Deno.utime(file, mtime, mtime);
    }
    for (const mode of ["off", "summary"]) {
      const destination = join(root, mode);
      await copyTree(source, destination);
      for (const input of inputs) {
        const file = join(destination, input.path), info = await Deno.stat(file);
        assert.equal(info.mtime?.toISOString(), input.mtime, `${mode}/${input.path}: lastmod`);
        assert.equal(await Deno.readTextFile(file), input.text);
        assert.equal((await Deno.stat(join(source, input.path))).mtime?.toISOString(), input.mtime);
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("рабочая копия исключает старые измерения и сохраняет выбранные исходники", async () => {
  const root = await Deno.makeTempDir();
  try {
    const source = join(root, "source");
    await Deno.mkdir(join(source, ".quarto/course-perf/runs/old"), { recursive: true });
    await Deno.writeTextFile(join(source, "index.qmd"), "# course");
    const old = join(source, ".quarto/course-perf/runs/old/private.json");
    await Deno.writeTextFile(old, "old");
    await copyTree(source, join(root, "copy"), { workingCopy: true });
    assert.deepEqual(
      (await files(join(root, "copy"))).map((x) => x.slice(join(root, "copy").length)),
      ["/index.qmd"],
    );
    await copyTree(source, join(root, "runtime"));
    assert.equal(
      await Deno.readTextFile(join(root, "runtime/.quarto/course-perf/runs/old/private.json")),
      "old",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
