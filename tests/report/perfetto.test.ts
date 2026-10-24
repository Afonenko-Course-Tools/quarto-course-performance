import { strict as assert } from "node:assert";
import { traces } from "../../src/report/perfetto.ts";
import { pair, run } from "./fixtures/perfetto/control.ts";

Deno.test("UUID mapping is numeric stable and preserves original context", () => {
  const a = pair("a", 0, 10, {
    document_id: "doc",
    symbol_id: "sym",
    attributes: {
      extension_id: "explicit",
      status: "forged",
      data_valid: true,
    },
  });
  const b = pair("b", 1, 4, { process_id: "uuid-second", operation_id: "course-core.work" });
  const first = traces(run([...a, ...b])), second = traces(run([...b, ...a]));
  const slices = first.wall.traceEvents.filter((e) => e.ph === "X");
  assert.equal(typeof slices[0].pid, "number");
  assert.notEqual(slices[0].pid, slices[1].pid);
  assert.deepEqual(first, second);
  assert.equal(slices[0].args.process_id, a[0].process_id);
  assert.equal(slices[0].args.executor_id, "ts");
  assert.equal(slices[0].args.span_id, "a");
  assert.equal(slices[0].args.parent_span_id, null);
  assert.equal(slices[0].args.document_id, "doc");
  assert.equal(slices[0].args.symbol_id, "sym");
  assert.equal(slices[0].args.origin, "manual");
  assert.equal(slices[0].args.status, "ok");
  assert.deepEqual(slices[0].args.source_attributes, a[0].attributes);
  assert.equal(slices[0].args.extension_attribution, "recorded");
  assert.equal(slices[1].args.extension_attribution, "derived");
  assert.equal(slices[1].args.document_id, null);
  assert(
    first.wall.traceEvents.some((e) =>
      e.ph === "M" && String(e.args.name).includes("логическая дорожка")
    ),
  );
});
Deno.test("async siblings use separate logical lanes", () => {
  const bundle = traces(run([...pair("a", 0, 10), ...pair("b", 5, 15)]));
  const slices = bundle.wall.traceEvents.filter((e) => e.ph === "X");
  assert.notEqual(slices[0].tid, slices[1].tid);
});
Deno.test("confirmed nested children share lanes while equal-bound siblings do not", () => {
  const slices = traces(
    run([...pair("a", 0, 20), ...pair("b", 0, 20), ...pair("c", 5, 10, { parent_span_id: "a" })]),
  ).wall.traceEvents.filter((e) => e.ph === "X");
  assert.notEqual(slices[0].tid, slices[1].tid);
  assert.equal(slices[0].tid, slices[2].tid);
});
Deno.test("uncalibrated wall stays local", () => {
  for (
    const calibration of [undefined, {}, { time_origin_ms: NaN }, { time_origin_ms: Infinity }]
  ) {
    const input = run(pair("a", 1, 10));
    input.executors[Object.keys(input.executors)[0]].calibration = calibration;
    const bundle = traces(input);
    assert.equal(bundle.localWall.length, 1);
    assert.equal(bundle.localWall[0].fileName, "local-wall-001.trace.json");
    assert.equal(bundle.wall.traceEvents.filter((e) => e.ph === "X").length, 0);
    assert.equal(bundle.localWall[0].trace.traceEvents.find((e) => e.ph === "X")?.ts, 1);
  }
  const calibrated = traces(run(pair("zero", 2, 9), { time_origin_ms: 0, uncertainty_us: 7 }));
  assert.equal(calibrated.wall.traceEvents.find((e) => e.ph === "X")?.args.uncertainty_us, 7);
  assert.equal(calibrated.localWall.length, 0);
});
Deno.test("damaged pairs and aborted spans never become normal slices", () => {
  for (
    const patch of [
      { run_id: "other" },
      { process_id: "other" },
      { executor_id: "other" },
      { operation_id: "other" },
      { clock_domain: "process_cpu" as const },
      { timestamp_us: -1 },
      { status: "aborted" as const },
    ]
  ) {
    const events = pair("a", 1, 10);
    Object.assign(events[1], patch);
    const bundle = traces(run(events));
    assert.equal(bundle.wall.traceEvents.filter((e) => e.ph === "X").length, 0);
  }
  for (
    const events of [pair("a", 1, 10).slice(0, 1), [...pair("a", 1, 10), pair("a", 1, 10)[0]], [
      ...pair("a", 1, 10),
      pair("a", 1, 10)[1],
    ]]
  ) {
    assert.equal(traces(run(events)).wall.traceEvents.filter((e) => e.ph === "X").length, 0);
  }
});

Deno.test("confirmed comparable parent has one logical flow", () => {
  for (const parentEnd of [20, 80]) {
    const bundle = traces(run([
      ...pair("parent", 0, parentEnd),
      ...pair("child", 30, 40, {
        process_id: "other-process",
        parent_span_id: "parent",
      }),
    ]));
    const links = bundle.wall.traceEvents.filter((e) => e.ph === "s" || e.ph === "f");
    assert.deepEqual(links.map((e) => e.ph), ["s", "f"]);
    assert.equal(links[0].id, links[1].id);
    assert.equal(typeof links[0].id, "number");
    assert.deepEqual(links.map((e) => e.ts), [0, 30]);
    assert.equal(links[0].args.relationship, "logical-parent");
  }
});
Deno.test("unknown reversed cross-run and incomparable parents have no flows", () => {
  const cases = [
    [...pair("parent", 40, 90), ...pair("child", 30, 40, { parent_span_id: "parent" })],
    [
      ...pair("parent", 0, 10, { run_id: "other" }),
      ...pair("child", 30, 40, { parent_span_id: "parent" }),
    ],
    [...pair("child", 30, 40, { parent_span_id: "unknown" })],
    [
      ...pair("parent", 0, 10),
      ...pair("child", 30, 40, {
        parent_span_id: "parent",
        clock_domain: "process_cpu",
        executor_id: "lua",
      }),
    ],
    [
      ...pair("parent", 0, 10, { clock_domain: "process_cpu", executor_id: "lua" }),
      ...pair("child", 30, 40, {
        parent_span_id: "parent",
        clock_domain: "process_cpu",
        executor_id: "lua-other",
      }),
    ],
  ];
  for (const events of cases) {
    const bundle = traces(run(events));
    for (const trace of [bundle.wall, bundle.luaCpu]) {
      assert.equal(trace.traceEvents.filter((e) => e.ph === "s" || e.ph === "f").length, 0);
    }
  }
  const calibrated = run([
    ...pair("parent", 0, 10),
    ...pair("child", 30, 40, { process_id: "remote", parent_span_id: "parent" }),
  ]);
  calibrated.executors["remote/ts"].calibration = { time_origin_ms: -1 };
  assert.equal(
    traces(calibrated).wall.traceEvents.filter((e) => e.ph === "s" || e.ph === "f").length,
    0,
  );
});
Deno.test("untimed counters and totals stay aggregates with independent quality and receipts", () => {
  const input = run([...pair("ok", 0, 1), {
    ...pair("counter", 0, 1)[0],
    event: "counter",
    executor_id: "counter",
    clock_domain: "none",
    timestamp_us: undefined,
    counter: { name: "calls", value: 1, quality: "partial" },
  }]);
  input.dataValid = false;
  const bundle = traces(input, [{
    process_id: input.events[0].process_id,
    parent_process_id: "parent",
    peak_rss_kib: 100,
  }]);
  assert(!bundle.wall.traceEvents.some((e) => String(e.ph) === "C"));
  const slice = bundle.wall.traceEvents.find((e) => e.ph === "X")!;
  assert.equal(slice.args.data_valid, false);
  assert.equal(slice.args.coverage_complete, false);
  const metadata = bundle.wall.traceEvents.find((e) => e.name === "process_name")!;
  assert.equal(
    (metadata.args.receipts as Record<string, unknown>[])[0].parent_process_id,
    "parent",
  );
  assert(!bundle.wall.traceEvents.some((e) => e.ph === "s" || e.ph === "f"));
});
