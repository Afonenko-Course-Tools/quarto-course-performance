import { strict as assert } from "node:assert";
import {
  compareOutputs,
  normalizeOutput as historicalNormalizeOutput,
} from "../../src/analysis/outputs.ts";
const normalizeOutput = (path: string, text: string) =>
  historicalNormalizeOutput(path, text, "java-pilot-core-qrc-v1");
Deno.test("output comparison retains teaching text, solutions, target links and unrelated timestamps", () => {
  const before = '<p>Задача</p><a href="a.html#target">Ответ 4</a>';
  for (
    const after of [
      before.replace("Задача", "Другая задача"),
      before.replace("4", "5"),
      before.replace("target", "other"),
    ]
  ) assert.notEqual(normalizeOutput("index.html", before), normalizeOutput("index.html", after));
  assert.notEqual(
    normalizeOutput("data.json", '{"timestamp":"a"}'),
    normalizeOutput("data.json", '{"timestamp":"b"}'),
  );
});

Deno.test("output comparison applies an explicit owner adapter only to HTML, with declared roots", async () => {
  const root = await Deno.makeTempDir();
  try {
    const left = root + "/left", right = root + "/right";
    await Deno.mkdir(left);
    await Deno.mkdir(right);
    await Deno.writeTextFile(left + "/a.html", "<p>/left/a.qmd</p>");
    await Deno.writeTextFile(right + "/a.html", "<p>/right/a.qmd</p>");
    assert.equal((await compareOutputs(left, right)).equivalent, false);
    const calls: string[] = [];
    const adapted = await compareOutputs(left, right, {
      outputPolicy: "java-pilot-core-qrc-v1",
      leftSourceRoot: "/left",
      rightSourceRoot: "/right",
      normalizeHtml: (html, sourceRoot) => {
        calls.push(sourceRoot!);
        return html.replace(sourceRoot!, "$ROOT");
      },
    });
    assert.equal(adapted.equivalent, true);
    assert.deepEqual(calls, ["/left", "/right"]);
    await Deno.writeTextFile(left + "/data.json", '{"root":"/left"}');
    await Deno.writeTextFile(right + "/data.json", '{"root":"/right"}');
    assert.equal(
      (await compareOutputs(left, right, {
        outputPolicy: "java-pilot-core-qrc-v1",
        normalizeHtml: () => "same",
      })).equivalent,
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("QRC metadata order stays literal without an explicit owner adapter", () => {
  const a =
    '<a data-qrc-ref="x:id" data-qrc-custom="false" data-qrc-style="default" href="x.html#id">Текст</a>';
  const b =
    '<a data-qrc-custom="false" data-qrc-style="default" data-qrc-ref="x:id" href="x.html#id">Текст</a>';
  assert.notEqual(normalizeOutput("index.html", a), normalizeOutput("index.html", b));
  assert.notEqual(
    normalizeOutput("index.html", a),
    normalizeOutput("index.html", b.replace("x:id", "x:other")),
  );
  assert.notEqual(
    normalizeOutput("index.html", "<script>const x=" + JSON.stringify(a) + "</script>"),
    normalizeOutput("index.html", "<script>const x=" + JSON.stringify(b) + "</script>"),
  );
});

Deno.test("exercise target/visibility order is technical but values are significant", () => {
  const a =
    '<div id="exr-a" class="theorem exercise" target="manual" data-statement-visibility="open">Условие</div>';
  const b =
    '<div id="exr-a" class="theorem exercise" data-statement-visibility="open" target="manual">Условие</div>';
  assert.equal(normalizeOutput("a.html", a), normalizeOutput("a.html", b));
  assert.notEqual(
    normalizeOutput("a.html", a),
    normalizeOutput("a.html", b.replace("open", "restricted")),
  );
});

Deno.test("duplicate attribute order stays significant because HTML uses the first value", () => {
  for (
    const [a, b] of [
      ['<a data-qrc-ref="a" data-qrc-ref="b">x</a>', '<a data-qrc-ref="b" data-qrc-ref="a">x</a>'],
      [
        '<div id="exr-a" target="a" target="b">x</div>',
        '<div id="exr-a" target="b" target="a">x</div>',
      ],
    ]
  ) assert.notEqual(normalizeOutput("a.html", a), normalizeOutput("a.html", b));
});

Deno.test("historical Core exercise metadata order is canonicalized", () => {
  const pairs = [
    [
      '<div id="exr-a" class="theorem exercise" data-course-difficulty="2" target="manual" data-course-time="10" data-statement-visibility="open">',
      '<div id="exr-a" class="theorem exercise" data-course-time="10" data-statement-visibility="open" target="manual" data-course-difficulty="2">',
    ],
  ];
  for (const [a, b] of pairs) {
    assert.equal(normalizeOutput("a.html", a), normalizeOutput("a.html", b));
    assert.notEqual(
      normalizeOutput("a.html", a),
      normalizeOutput("a.html", b.replace('="', '="changed-')),
    );
    for (const prefix of ["<script>", "<style>", "<!--"]) {
      const suffix = prefix === "<!--" ? "-->" : prefix.replace("<", "</");
      assert.notEqual(
        normalizeOutput("a.html", prefix + a + suffix),
        normalizeOutput("a.html", prefix + b + suffix),
      );
    }
  }
  const a = '<div class="other" data-qrc-title="a" data-qrc-id="b">';
  const b = '<div class="other" data-qrc-id="b" data-qrc-title="a">';
  assert.notEqual(normalizeOutput("a.html", a), normalizeOutput("a.html", b));
  const dup =
    '<div class="qrc-probe" data-qrc-id="first" data-qrc-style="default" data-qrc-id="second">';
  assert.notEqual(
    normalizeOutput("a.html", dup),
    normalizeOutput(
      "a.html",
      dup.replace("first", "TEMP").replace("second", "first").replace("TEMP", "second"),
    ),
  );
});

Deno.test("strict default preserves HTML attribute order and ignores historical adapter unless opted in", async () => {
  const root = await Deno.makeTempDir();
  try {
    const left = root + "/left", right = root + "/right";
    await Deno.mkdir(left);
    await Deno.mkdir(right);
    const a = '<div id="exr-a" target="x" data-course-time="2">';
    const b = '<div id="exr-a" data-course-time="2" target="x">';
    await Deno.writeTextFile(left + "/index.html", a);
    await Deno.writeTextFile(right + "/index.html", b);
    assert.equal((await compareOutputs(left, right)).equivalent, false);
    assert.equal(
      (await compareOutputs(left, right, { normalizeHtml: () => "same" })).equivalent,
      false,
    );
    assert.equal(
      (await compareOutputs(left, right, { outputPolicy: "java-pilot-core-qrc-v1" })).equivalent,
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("strict output comparison keeps ZIP container bytes literal", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(root + "/left");
    await Deno.mkdir(root + "/right");
    await Deno.writeTextFile(root + "/left/a.zip", "container A");
    await Deno.writeTextFile(root + "/right/a.zip", "container B");
    assert.equal((await compareOutputs(root + "/left", root + "/right")).equivalent, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
