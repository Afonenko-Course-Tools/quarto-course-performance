import { strict as assert } from "node:assert";
import { normalizeOutput } from "../../src/analysis/outputs.ts";
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

Deno.test("only unordered QRC metadata attributes are canonicalized, script strings stay literal", () => {
  const a =
    '<a data-qrc-ref="x:id" data-qrc-custom="false" data-qrc-style="default" href="x.html#id">Текст</a>';
  const b =
    '<a data-qrc-custom="false" data-qrc-style="default" data-qrc-ref="x:id" href="x.html#id">Текст</a>';
  assert.equal(normalizeOutput("index.html", a), normalizeOutput("index.html", b));
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
