import { strict as assert } from "node:assert";
import { operationTotals, writeExperimentReport } from "../../src/analysis/report.ts";
import type { NormalizedRun } from "../../src/analysis/normalize.ts";
import type { Event } from "../../src/protocol/types.ts";
import { join } from "node:path";
Deno.test("report separates clock totals, does not claim self time, and retains failed build evidence", async () => {
  const root = await Deno.makeTempDir();
  const event = (
    event: "begin" | "end",
    id: string,
    time: number,
    clock: "process_cpu" | "monotonic_process",
  ): Event => ({
    schema_version: 1,
    experiment_id: "e",
    run_id: "r",
    process_id: "p",
    executor_id: "ts",
    sequence: event === "begin" ? 1 : 2,
    event,
    kind: "phase",
    span_id: id,
    operation_id: "same",
    origin: "manual",
    clock_domain: clock,
    timestamp_us: time,
    status: event === "end" ? "ok" : undefined,
  });
  const run: NormalizedRun = {
    runId: "r",
    dataValid: true,
    quality: { droppedEvents: 0, incompleteSpans: 0, coverageComplete: true, errors: [] },
    executors: {},
    events: [
      event("begin", "s", 10, "monotonic_process"),
      event("end", "s", 30, "monotonic_process"),
      event("begin", "l", 100, "process_cpu"),
      event("end", "l", 110, "process_cpu"),
    ],
  };
  try {
    assert.deepEqual(operationTotals(run).map((o) => [o.clock, o.inclusive_us, o.self_us]), [[
      "monotonic_process",
      20,
      null,
    ], ["process_cpu", 10, null]]);
    await Deno.mkdir(join(root, "runs/r"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "runs/r/run.json"),
      JSON.stringify({ runId: "r", buildExitCode: 23, mode: "off", dataValid: true }),
    );
    await writeExperimentReport({ experimentId: "e", sources: [], packages: [], runtime: {} }, [
      run,
    ], root);
    assert.equal(
      JSON.parse(await Deno.readTextFile(join(root, "builds.json")))[0].buildExitCode,
      23,
    );
    assert((await Deno.readTextFile(join(root, "report.md"))).includes("23"));
    assert.deepEqual(JSON.parse(await Deno.readTextFile(join(root, "coverage.json"))), []);
    assert.deepEqual(
      JSON.parse(await Deno.readTextFile(join(root, "runs/r/causal.json"))).spans.map((
        s: { clock_domain: string },
      ) => s.clock_domain),
      ["monotonic_process", "process_cpu"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("report processes an async run stream before requesting the next raw journal", async () => {
  const root = await Deno.makeTempDir();
  const run: NormalizedRun = {
    runId: "r",
    events: [],
    dataValid: true,
    executors: {},
    quality: { droppedEvents: 0, incompleteSpans: 0, coverageComplete: true, errors: [] },
  };
  try {
    async function* runs() {
      yield run;
      assert((await Deno.stat(join(root, "runs/r/wall.trace.json"))).isFile);
      assert.equal(
        JSON.parse(await Deno.readTextFile(join(root, "runs/r/summary.json"))).schema_version,
        2,
      );
      await Deno.stat(join(root, "runs/r/report.md"));
      yield { ...run, runId: "second" };
    }
    await Deno.mkdir(join(root, "benchmarks"));
    await Deno.writeTextFile(
      join(root, "benchmarks/scenario.initial10.json"),
      JSON.stringify({
        scenario: "scenario",
        complete: true,
        left: "clean-control",
        right: "candidate",
        comparison: { pairs: 10, medianRatio: 1, interval95: [.99, 1.02], status: "INCONCLUSIVE" },
      }),
    );
    await writeExperimentReport(
      { experimentId: "e", sources: [], packages: [], runtime: {} },
      runs(),
      root,
    );
    const summary = JSON.parse(await Deno.readTextFile(join(root, "summary.json")));
    assert.deepEqual(summary.map((r: { run_id: string }) => r.run_id), ["r", "second"]);
    assert(
      (await Deno.readTextFile(join(root, "report.md"))).includes(
        "benchmarks/scenario.initial10.json",
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("legacy Quarto render metadata preserves the executable and only argv after render", async () => {
  const root = await Deno.makeTempDir();
  try {
    const manifest = { experimentId: "e", sources: [], packages: [], runtime: {} };
    for (const executable of ["quarto", "/usr/bin/quarto"]) {
      const runId = executable === "quarto" ? "bare" : "absolute";
      const dir = join(root, "runs", runId);
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        join(dir, "run.json"),
        JSON.stringify({
          runId,
          cwd: "/original/cwd",
          argv: [executable, "render", "page.qmd", "--profile", "student", "--", "--help"],
          mode: "off",
          buildExitCode: 7,
          wallSeconds: 1,
          preparation: [],
        }),
      );
      await writeExperimentReport(manifest, [{
        runId,
        events: [],
        executors: {},
        dataValid: true,
        quality: { droppedEvents: 0, incompleteSpans: 0, coverageComplete: true, errors: [] },
      }], root);
      const converted = JSON.parse(await Deno.readTextFile(join(dir, "run.json")));
      assert.equal(converted.request.quarto, executable);
      assert.deepEqual(converted.request.nativeArgv, [
        "page.qmd",
        "--profile",
        "student",
        "--",
        "--help",
      ]);
      assert.deepEqual(converted.argv, [
        executable,
        "render",
        "page.qmd",
        "--profile",
        "student",
        "--",
        "--help",
      ]);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("legacy arbitrary commands are not silently relabeled as native Quarto render", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const argv of [["python3", "render", "page.qmd"], ["quarto", "preview", "page.qmd"]]) {
      const dir = join(root, "runs/r");
      await Deno.mkdir(dir, { recursive: true });
      const legacy = JSON.stringify({
        runId: "r",
        cwd: "/original",
        argv,
        mode: "off",
        buildExitCode: 0,
      });
      await Deno.writeTextFile(join(dir, "run.json"), legacy);
      await assert.rejects(
        () =>
          writeExperimentReport({ experimentId: "e", sources: [], packages: [], runtime: {} }, [{
            runId: "r",
            events: [],
            executors: {},
            dataValid: true,
            quality: { droppedEvents: 0, incompleteSpans: 0, coverageComplete: true, errors: [] },
          }], root),
        /Quarto render/,
      );
      assert.equal(await Deno.readTextFile(join(dir, "run.json")), legacy);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
