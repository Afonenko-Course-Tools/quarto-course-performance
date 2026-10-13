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
    sequence: 1,
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
