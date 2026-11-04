import { strict as assert } from "node:assert";
import { compareOutputs } from "../../src/analysis/outputs.ts";

Deno.test("Java policy оставляет HTML content непроверенным, но обнаруживает отсутствие HTML", async () => {
  const root = await Deno.makeTempDir();
  try {
    const left = root + "/left", right = root + "/right";
    await Deno.mkdir(left);
    await Deno.mkdir(right);
    await Deno.writeTextFile(left + "/index.html", '<a id="a" href="a.html">Первый</a>');
    await Deno.writeTextFile(right + "/index.html", '<a href="b.html" id="b">Другой</a>');
    const result = await compareOutputs(left, right, { outputPolicy: "java-pilot-core-qrc-v1" });
    assert.deepEqual(result.differences, []);
    assert.equal(result.checkedContentEqual, true);
    assert.equal(result.htmlBytesCompared, false);
    assert.equal("equivalent" in result, false);
    await Deno.remove(right + "/index.html");
    const missing = await compareOutputs(left, right, { outputPolicy: "java-pilot-core-qrc-v1" });
    assert.equal(missing.checkedContentEqual, false);
    assert.equal(missing.differences.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Java policy обнаруживает изменённые bytes ресурса", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(root + "/left");
    await Deno.mkdir(root + "/right");
    await Deno.writeFile(root + "/left/data.bin", new Uint8Array([0, 1, 255]));
    await Deno.writeFile(root + "/right/data.bin", new Uint8Array([0, 2, 255]));
    const changed = await compareOutputs(root + "/left", root + "/right", {
      outputPolicy: "java-pilot-core-qrc-v1",
    });
    assert.equal(changed.checkedContentEqual, false);
    assert.equal(changed.differences.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Java policy проверяет имена ZIP entries и распакованные bytes", async () => {
  const root = await Deno.makeTempDir();
  try {
    const left = root + "/left", right = root + "/right", input = root + "/input";
    await Deno.mkdir(left);
    await Deno.mkdir(right);
    await Deno.mkdir(input);
    const pack = async (destination: string, name: string, text: string, comment: string) => {
      await Deno.writeTextFile(input + "/" + name, text);
      const zip = await new Deno.Command("zip", {
        cwd: input,
        args: ["-q", "-z", destination, name],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = zip.stdin.getWriter();
      await writer.write(new TextEncoder().encode(comment + "\n"));
      await writer.close();
      const packed = await zip.output();
      assert.equal(packed.success, true, new TextDecoder().decode(packed.stderr));
    };
    const compare = () => compareOutputs(left, right, { outputPolicy: "java-pilot-core-qrc-v1" });
    await pack(left + "/a.zip", "README.md", "Условие", "first container");
    await pack(right + "/a.zip", "README.md", "Условие", "other container");
    assert.equal((await compare()).checkedContentEqual, true);
    await Deno.remove(right + "/a.zip");
    await pack(right + "/a.zip", "README.md", "Другие bytes", "changed container");
    assert.equal((await compare()).checkedContentEqual, false);
    await Deno.remove(right + "/a.zip");
    await pack(right + "/a.zip", "OTHER.md", "Условие", "renamed container");
    assert.equal((await compare()).checkedContentEqual, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Strict default различает порядок HTML, невалидный UTF-8 и bytes ZIP контейнера", async () => {
  const root = await Deno.makeTempDir();
  try {
    const left = root + "/left", right = root + "/right";
    await Deno.mkdir(left);
    await Deno.mkdir(right);
    for (
      const [a, b] of [
        [
          new TextEncoder().encode('<a id="x" href="x">'),
          new TextEncoder().encode('<a href="x" id="x">'),
        ],
        [new Uint8Array([60, 112, 62, 0x80]), new Uint8Array([60, 112, 62, 0x81])],
      ]
    ) {
      await Deno.writeFile(left + "/index.html", a);
      await Deno.writeFile(right + "/index.html", b);
      assert.equal((await compareOutputs(left, right)).equivalent, false);
    }
    await Deno.remove(left + "/index.html");
    await Deno.remove(right + "/index.html");
    await Deno.writeTextFile(left + "/a.zip", "container A");
    await Deno.writeTextFile(right + "/a.zip", "container B");
    assert.equal((await compareOutputs(left, right)).equivalent, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
