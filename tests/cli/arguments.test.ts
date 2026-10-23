import { strict as assert } from "node:assert";

async function parse(argv: readonly string[]) {
  const path = "../../src/cli/arguments.ts";
  return (await import(path)).parseCommand(argv);
}

Deno.test("render consumes only the initial perf prefix and preserves native argv", async () => {
  assert.deepEqual(await parse(["render", "--perf-mode=summary", "--to", "html"]), {
    kind: "render",
    mode: "summary",
    nativeArgv: ["--to", "html"],
  });
  assert.deepEqual(
    await parse(["render", "--perf-mode", "cpu", "--perf-output", "/tmp/runs", "a.qmd"]),
    {
      kind: "render",
      mode: "cpu",
      outputParent: "/tmp/runs",
      nativeArgv: ["a.qmd"],
    },
  );
  assert.deepEqual((await parse(["render", "--perf-output=/tmp/runs"])).outputParent, "/tmp/runs");
  assert.deepEqual((await parse(["render"])).nativeArgv, []);
  assert.equal((await parse(["render"])).mode, "off");
  for (const native of [["a.qmd", "--perf-mode=cpu"], ["--to", "html", "--perf-other"]]) {
    assert.deepEqual((await parse(["render", ...native])).nativeArgv, native);
  }
  assert.deepEqual((await parse(["render", "--", "--", "topic.qmd"])).nativeArgv, [
    "--",
    "topic.qmd",
  ]);
  assert.deepEqual((await parse(["render", "--", "--help"])).nativeArgv, ["--help"]);
});

Deno.test("render rejects invalid perf prefix without stealing native parameters", async () => {
  for (
    const args of [
      ["--perf-mode"],
      ["--perf-mode="],
      ["--perf-output"],
      ["--perf-output="],
      ["--perf-mode", "--to"],
      ["--perf-mode=invalid"],
      ["--perf-unknown=x"],
      ["--perf-mode=off", "--perf-mode", "cpu"],
      ["--perf-output=x", "--perf-output=y"],
    ]
  ) await assert.rejects(() => parse(["render", ...args]));
  await assert.rejects(() => parse(["render", "--perf-mode=trace"]), /experiment run --mode trace/);
});

Deno.test("top-level commands are explicit and experiment argv remain isolated", async () => {
  for (const argv of [[], ["--help"], ["help"]]) {
    assert.deepEqual(await parse(argv), { kind: "help" });
  }
  assert.deepEqual(await parse(["--version"]), { kind: "version" });
  assert.deepEqual(await parse(["experiment", "run", "--mode", "trace"]), {
    kind: "experiment",
    argv: ["run", "--mode", "trace"],
  });
  for (const argv of [["run"], ["--help", "extra"], ["--version", "extra"]]) {
    await assert.rejects(() => parse(argv));
  }
});
