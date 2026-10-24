import { strict as assert } from "node:assert";
import { operationTotals, writeExperimentReport } from "../../src/analysis/report.ts";
import type { NormalizedRun } from "../../src/analysis/normalize.ts";
import type { Event } from "../../src/protocol/types.ts";
import { record } from "../report/fixture.ts";
import { join, resolve } from "node:path";
import { pair, run as fixtureRun } from "../report/fixtures/perfetto/control.ts";
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
      JSON.stringify({
        ...record(root, "r"),
        request: { ...record(root, "r").request, mode: "trace" },
        buildExitCode: 23,
        mode: "trace",
      }),
    );
    await writeExperimentReport({
      schema_version: 2 as const,
      projectSource: "org/Fixture",
      replacements: [],
      experimentId: "e",
      sources: [],
      packages: [],
      runtime: {},
    }, [
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
    for (const id of ["r", "second"]) {
      await Deno.mkdir(join(root, "runs", id), { recursive: true });
      await Deno.writeTextFile(
        join(root, "runs", id, "run.json"),
        JSON.stringify({
          ...record(root, id),
          request: { ...record(root, id).request, mode: "trace" },
        }),
      );
    }
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
      {
        schema_version: 2 as const,
        projectSource: "org/Fixture",
        replacements: [],
        experimentId: "e",
        sources: [],
        packages: [],
        runtime: {},
      },
      runs(),
      root,
    );
    const summary = JSON.parse(await Deno.readTextFile(join(root, "summary.json")));
    assert.deepEqual(summary.runs.map((r: { run_id: string }) => r.run_id), ["r", "second"]);
    assert(
      (await Deno.readTextFile(join(root, "report.md"))).includes(
        "benchmarks/scenario.initial10.json",
      ),
    );
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
          writeExperimentReport({
            schema_version: 2 as const,
            projectSource: "org/Fixture",
            replacements: [],
            experimentId: "e",
            sources: [],
            packages: [],
            runtime: {},
          }, [{
            runId: "r",
            events: [],
            executors: {},
            dataValid: true,
            quality: { droppedEvents: 0, incompleteSpans: 0, coverageComplete: true, errors: [] },
          }], root),
        /read-only/,
      );
      assert.equal(await Deno.readTextFile(join(dir, "run.json")), legacy);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("experiment report displays each saved benchmark threshold without a global Java policy", async () => {
  const { compareBenchmarks } = await import("../../src/analysis/compare.ts");
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "benchmarks"));
    for (const [scenario, threshold] of [["lenient", 1.2], ["tight", 1.05]] as const) {
      await Deno.writeTextFile(
        join(root, "benchmarks", scenario + ".json"),
        JSON.stringify({
          scenario,
          complete: true,
          left: "clean-control",
          right: "candidate",
          comparison: compareBenchmarks([1.1], 42, threshold),
        }),
      );
    }
    await writeExperimentReport(
      {
        schema_version: 2 as const,
        projectSource: "org/Fixture",
        replacements: [],
        experimentId: "e",
        sources: [],
        packages: [],
        runtime: {},
      },
      [],
      root,
    );
    const report = await Deno.readTextFile(join(root, "report.md"));
    assert.match(report, /\| Порог ratio \|/);
    assert.match(report, /\[lenient\][^\n]+\| 1\.20000 \|[^\n]+\| PASS \|/);
    assert.match(report, /\[tight\][^\n]+\| 1\.05000 \|[^\n]+\| FAIL \|/);
    assert(!report.includes("≤1.01"));
    assert(!report.includes(">1.01"));
    assert.match(report, /порога серии/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("experiment links survive relocation with trace CPU and off adapters", async () => {
  const root = await Deno.makeTempDir();
  try {
    const stage = join(root, "stage folder"), final = join(root, "final folder");
    const normalized = fixtureRun(pair("phase", 1, 9));
    const runs = [normalized, { ...fixtureRun([]), runId: "off" }];
    for (const r of runs) {
      const dir = join(stage, "runs", r.runId);
      await Deno.mkdir(dir, { recursive: true });
      const rec = record(dir, r.runId);
      rec.request.mode = r.runId === "off" ? "off" : "cpu";
      await Deno.writeTextFile(join(dir, "run.json"), JSON.stringify(rec));
      if (r.runId !== "off") {
        await Deno.mkdir(join(dir, "profiles/with spaces"), { recursive: true });
        await Deno.writeTextFile(join(dir, "profiles/with spaces/cpu.cpuprofile"), "{}");
      }
    }
    await writeExperimentReport(
      {
        schema_version: 2,
        projectSource: "org/Fixture",
        replacements: [],
        experimentId: "control",
        sources: [],
        packages: [],
        runtime: {},
      },
      runs,
      stage,
    );
    await Deno.rename(stage, final);
    for (const file of ["report.md", "runs/fixture/report.md", "runs/off/report.md"]) {
      const report = await Deno.readTextFile(join(final, file));
      for (const match of report.matchAll(/\]\(([^)]+)\)/g)) {
        await Deno.stat(resolve(final, file, "..", decodeURI(match[1])));
      }
    }
    assert(
      (await Deno.readTextFile(join(final, "runs/fixture/report.md"))).includes(
        "profiles/with%20spaces/cpu.cpuprofile",
      ),
    );
    await assert.rejects(
      () => Deno.stat(join(final, "runs/off/wall.trace.json")),
      Deno.errors.NotFound,
    );
    const metadata = JSON.parse(await Deno.readTextFile(join(final, "runs/fixture/run.json")));
    assert.equal(metadata.collectionDirectory, join(stage, "runs/fixture"));
    assert.equal(metadata.outputDirectory, "/final/test");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
