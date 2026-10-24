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
        calibration: { time_origin_ms: 0 },
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
    assert.equal(result.wall.traceEvents.filter((e) => e.ph === "X").length, 1);
    assert.equal(result.luaCpu.traceEvents.filter((e) => e.ph === "X").length, 1);
    assert.equal(
      result.wall.traceEvents.find((e) => e.ph === "X")!.args.self_time,
      "not-available",
    );
    assert.equal(
      result.luaCpu.traceEvents.find((e) => e.ph === "X")!.args.clock_domain,
      "process_cpu",
    );
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
Deno.test("aborted native processes and missing Lua filter summaries invalidate a run", async () => {
  const root = await input([span("begin", 1), span("end", 2)]);
  try {
    await Deno.mkdir(join(root, "processes"));
    await Deno.writeTextFile(
      join(root, "processes/pandoc.json"),
      JSON.stringify({
        process_id: "lua-child",
        kind: "pandoc",
        argv: ["--lua-filter", "main.lua"],
        signal: "SIGKILL",
        exit_code: 137,
      }),
    );
    const run = await normalizeRun(root);
    assert.equal(run.dataValid, false);
    assert(run.quality.errors.some((e) => e.includes("SIGKILL")));
    assert(run.quality.errors.some((e) => e.includes("Lua child")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("an explicitly aborted span is incomplete even when a closing row exists", async () => {
  const root = await input([span("begin", 1), { ...span("end", 2), status: "aborted" }]);
  try {
    const r = await normalizeRun(root);
    assert.equal(r.dataValid, false);
    assert.equal(r.quality.incompleteSpans, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("unconfirmed begin/end pairs never contribute totals or trace intervals", async () => {
  const { operationTotals } = await import("../../src/report/run.ts");
  for (
    const patch of [
      { experiment_id: "other" },
      { run_id: "other" },
      { process_id: "other" },
      { executor_id: "other" },
      { operation_id: "other" },
      { clock_domain: "process_cpu" },
      { timestamp_us: 0 },
    ]
  ) {
    const root = await input([span("begin", 1), { ...span("end", 2), ...patch }]);
    try {
      const run = await normalizeRun(root);
      assert.equal(run.events.length, 2);
      assert.deepEqual(operationTotals(run), []);
      assert.equal(traces(run).wall.traceEvents.filter((e) => e.ph === "X").length, 0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
  for (
    const rows of [[span("begin", 1), span("end", 2), span("end", 3)], [
      span("begin", 1),
      span("begin", 2),
      span("end", 3),
    ], [span("begin", 1)]]
  ) {
    const root = await input(rows);
    try {
      const run = await normalizeRun(root);
      assert.deepEqual(operationTotals(run), []);
      assert.equal(run.events.length, rows.length);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});
Deno.test("v2 expectations allow no-child freeze help and no-markup without inventing complete coverage", async () => {
  for (const name of ["no-child", "freeze", "help", "no-markup"]) {
    const root = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(root, "expectations.json"),
        JSON.stringify({
          schema_version: 2,
          processes: name === "no-child" || name === "freeze" ? [] : [{
            process_id: name,
            agent: name === "help" ? "ts" : "lua",
            requested: true,
            supported: true,
            activated: false,
            executed: false,
          }],
        }),
      );
      const run = await normalizeRun(root);
      assert.equal(run.dataValid, true, JSON.stringify(run.quality));
      assert.equal(run.quality.coverageComplete, false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});
Deno.test("explicit missing expected summary and profile remain invalid even with no observed spans", async () => {
  for (
    const expected of [{ summary_path: "events/p/ts.summary.json" }, {
      profile_path: "profiles/p/cpu.cpuprofile",
    }]
  ) {
    const root = await input([]);
    try {
      await Deno.writeTextFile(
        join(root, "expectations.json"),
        JSON.stringify({
          schema_version: 2,
          processes: [{
            process_id: "missing",
            agent: "ts",
            requested: true,
            supported: true,
            activated: true,
            executed: true,
            ...expected,
          }],
        }),
      );
      const run = await normalizeRun(root);
      assert.equal(run.dataValid, false);
      assert(run.quality.errors.some((e) => e.includes("missing")));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("expectation receipts reject impossible activation and unsafe artifact paths", async () => {
  for (
    const patch of [
      { supported: false },
      { requested: false },
      { summary_path: "../outside.json" },
      { agent: "python" },
      { executed: "yes" },
    ]
  ) {
    const root = await input([]);
    try {
      await Deno.writeTextFile(
        join(root, "expectations.json"),
        JSON.stringify({
          schema_version: 2,
          processes: [{
            process_id: "p",
            agent: "ts",
            requested: true,
            supported: true,
            activated: true,
            executed: true,
            ...patch,
          }],
        }),
      );
      assert.equal((await normalizeRun(root)).dataValid, false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});
Deno.test("operation owner attribution distinguishes recorded context from legacy derived prefix", async () => {
  const { operationTotals } = await import("../../src/report/run.ts");
  for (const recorded of [false, true]) {
    const root = await input([{
      ...span("begin", 1),
      operation_id: "course-core.phase",
      ...(recorded ? { attributes: { extension_id: "explicit-owner" } } : {}),
    }, { ...span("end", 2), operation_id: "course-core.phase" }]);
    try {
      const run = await normalizeRun(root), total = operationTotals(run)[0];
      assert.equal(total.extension_id, recorded ? "explicit-owner" : "course-core");
      assert.equal(total.extension_attribution, recorded ? "recorded" : "derived");
      assert.equal(run.events[0].attributes?.extension_id, recorded ? "explicit-owner" : undefined);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("Lua namespace expectations require every started executor summary after relocation", async () => {
  const root = await input([]), moved = root + "-moved";
  try {
    await Deno.writeTextFile(
      join(root, "expectations.json"),
      JSON.stringify({
        schema_version: 2,
        processes: [{
          process_id: "p",
          agent: "lua",
          requested: true,
          supported: true,
          activated: true,
          executed: true,
          summary_path: "events/p/",
        }],
      }),
    );
    const summary = {
      schema_version: 1,
      experiment_id: "e",
      run_id: "r",
      process_id: "p",
      executor_id: "lua-one",
      clock_domain: "process_cpu",
      counters: {},
      data_valid: true,
      dropped_events: 0,
      incomplete_spans: 0,
    };
    await Deno.writeTextFile(join(root, "events/p/lua-one.summary.json"), JSON.stringify(summary));
    for (const executor_id of ["lua-one", "lua-two"]) {
      await Deno.writeTextFile(
        join(root, `events/p/${executor_id}.started.json`),
        JSON.stringify({
          schema_version: 1,
          process_id: "p",
          agent: "lua",
          executor_id,
          executed: true,
        }),
      );
    }
    await Deno.rename(root, moved);
    const lost = await normalizeRun(moved);
    assert.equal(lost.dataValid, false);
    assert(lost.quality.errors.some((e) => e.includes("lua-two")));
    await Deno.writeTextFile(
      join(moved, "events/p/lua-two.summary.json"),
      JSON.stringify({ ...summary, executor_id: "lua-two" }),
    );
    assert.equal((await normalizeRun(moved)).dataValid, true);
    await Deno.remove(join(moved, "expectations.json"));
    await Deno.remove(join(moved, "events/p/lua-two.summary.json"));
    assert.equal((await normalizeRun(moved)).dataValid, false);
  } finally {
    await Deno.remove(moved, { recursive: true }).catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
Deno.test("coverage separates installed instrumentation observations and integrity", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(root, "expectations.json"),
      JSON.stringify({ schema_version: 2, processes: [] }),
    );
    await Deno.writeTextFile(
      join(root, "coverage.json"),
      JSON.stringify({
        complete: false,
        installed: { ts: true, lua: true },
        instrumented: { ts: true, lua: true },
        observed: { ts: false, lua: false },
        integrity: "pending",
      }),
    );
    const run = await normalizeRun(root);
    assert(run.dataValid);
    const c = JSON.parse(await Deno.readTextFile(join(root, "coverage.json")));
    assert.deepEqual(c.installed, { ts: true, lua: true });
    assert.deepEqual(c.instrumented, { ts: false, lua: false });
    assert.deepEqual(c.observed, { ts: false, lua: false });
    assert.equal(c.integrity, "valid");
    assert.equal(c.complete, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("observed executor start activates an unanticipated Lua boundary and still requires summary", async () => {
  const root = await input([]);
  try {
    await Deno.writeTextFile(
      join(root, "expectations.json"),
      JSON.stringify({
        schema_version: 2,
        processes: [{
          process_id: "p",
          agent: "lua",
          requested: true,
          supported: true,
          activated: false,
          executed: false,
        }],
      }),
    );
    await Deno.writeTextFile(
      join(root, "events/p/lua-known.started.json"),
      JSON.stringify({
        schema_version: 1,
        process_id: "p",
        executor_id: "lua-known",
        agent: "lua",
        executed: true,
      }),
    );
    const run = await normalizeRun(root);
    assert.equal(run.dataValid, false);
    const e = JSON.parse(await Deno.readTextFile(join(root, "expectations.json"))).processes[0];
    assert.equal(e.executed, true);
    assert.equal(e.activated, true);
    assert.equal(e.summary_path, "events/p/");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("mixed old and new bridge calls never label derived owner attribution as recorded", async () => {
  const { operationTotals } = await import("../../src/report/run.ts");
  const root = await input([
    {
      ...span("begin", 1, "recorded"),
      operation_id: "course-core.phase",
      attributes: { extension_id: "course-core" },
    },
    { ...span("end", 2, "recorded"), operation_id: "course-core.phase" },
    { ...span("begin", 3, "legacy"), operation_id: "course-core.phase" },
    { ...span("end", 4, "legacy"), operation_id: "course-core.phase" },
  ]);
  try {
    const totals = operationTotals(await normalizeRun(root));
    assert.deepEqual(totals.map((t) => [t.extension_attribution, t.completed]).sort(), [[
      "derived",
      1,
    ], ["recorded", 1]]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
