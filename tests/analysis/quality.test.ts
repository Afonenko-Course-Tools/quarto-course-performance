import { strict as assert } from "node:assert";
import { join } from "node:path";
import { normalizeRun } from "../../src/analysis/normalize.ts";
import { traces } from "../../src/report/perfetto.ts";
function span(event: string, sequence: number, id = "s", clock = "monotonic_process", run = "r") {
  return {
    schema_version: 1,
    experiment_id: "e",
    run_id: run,
    process_id: "p",
    executor_id: clock === "process_cpu" ? "lua" : "ts",
    sequence,
    event,
    kind: "phase",
    span_id: id,
    operation_id: id,
    origin: "manual",
    clock_domain: clock,
    timestamp_us: sequence * 100,
    status: event === "end" ? "ok" : undefined,
  };
}
async function input(
  lines: unknown[],
  summary: unknown = { data_valid: true, dropped_events: 0, incomplete_spans: 0, counters: {} },
) {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(join(root, "events/p"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "events/p/ts.jsonl"),
    lines.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join("\n") + "\n",
  );
  for (
    const executor of new Set([
      "ts",
      ...lines.filter((x) => typeof x === "object" && x !== null).map((x) =>
        (x as { executor_id: string }).executor_id
      ),
    ])
  ) {
    await Deno.writeTextFile(
      join(root, `events/p/${executor}.summary.json`),
      JSON.stringify({
        schema_version: 1,
        experiment_id: "e",
        run_id: "r",
        process_id: "p",
        executor_id: executor,
        clock_domain: executor === "lua" ? "process_cpu" : "monotonic_process",
        counters: {},
        ...summary as object,
      }),
    );
  }
  return root;
}
Deno.test("normalization rejects lost data, incomplete spans, cross-run rows and broken JSONL", async () => {
  for (
    const rows of [[span("begin", 1)], [span("end", 1)], [
      span("begin", 1),
      span("end", 2, "s", "monotonic_process", "other"),
    ], [span("begin", 1), "{bad"]]
  ) {
    const root = await input(rows);
    try {
      assert.equal((await normalizeRun(root)).dataValid, false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
  const root = await input([span("begin", 1), span("end", 2)], {
    data_valid: false,
    dropped_events: 2,
    incomplete_spans: 0,
  });
  try {
    const run = await normalizeRun(root);
    assert.equal(run.quality.droppedEvents, 2);
    assert.equal(run.dataValid, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("Lua CPU spans never enter wall trace and async self time is unavailable", async () => {
  const root = await input([
    span("begin", 1),
    span("end", 2),
    span("begin", 1, "lua", "process_cpu"),
    span("end", 2, "lua", "process_cpu"),
  ]);
  try {
    const run = await normalizeRun(root);
    assert(run.dataValid);
    const result = traces(run);
    assert.equal(result.wall.traceEvents.length, 1);
    assert.equal(result.luaCpu.traceEvents.length, 1);
    assert.equal(result.wall.traceEvents[0].args.self_time, "not-available");
    assert.equal(result.luaCpu.traceEvents[0].args.clock_domain, "process_cpu");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("normalizer rejects parent cycles, explicitly invalidated runs and missing child summaries", async () => {
  const root = await input([{ ...span("begin", 1), parent_span_id: "s" }, span("end", 2)]);
  try {
    assert.equal((await normalizeRun(root)).dataValid, false);
    await Deno.writeTextFile(
      join(root, "invalidated.json"),
      JSON.stringify({ reason: "clock correction" }),
    );
    const r = await normalizeRun(root);
    assert(r.quality.errors.some((x) => x.includes("clock correction")));
    await Deno.mkdir(join(root, "processes"));
    await Deno.writeTextFile(
      join(root, "processes/missing.json"),
      JSON.stringify({
        process_id: "missing",
        kind: "deno",
        argv: ["run", "entry.ts"],
        exit_code: 0,
        signal: null,
      }),
    );
    const missing = await normalizeRun(root);
    assert(missing.quality.errors.some((x) => x.includes("missing")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("summary identity, counters and clock metadata are validated even without spans", async () => {
  for (
    const summary of [{ run_id: "other" }, { counters: { bad: -1 } }, { clock_domain: "wall" }]
  ) {
    const root = await input([], {
      data_valid: true,
      dropped_events: 0,
      incomplete_spans: 0,
      ...summary,
    });
    try {
      await Deno.writeTextFile(
        join(root, "mode.json"),
        JSON.stringify({ runId: "r", experimentId: "e" }),
      );
      assert.equal((await normalizeRun(root)).dataValid, false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});
