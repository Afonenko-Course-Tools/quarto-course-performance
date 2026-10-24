import { strict as assert } from "node:assert";
import { validateEvent } from "../../src/protocol/validate.ts";

import { validateRunRecord, validateRunSummary } from "../../src/report/types.ts";
import type { RunRecord, RunSummary } from "../../src/report/types.ts";

const quality = { droppedEvents: 0, incompleteSpans: 0, coverageComplete: false, errors: [] };
const run = {
  schema_version: 2,
  runId: "native-1",
  request: {
    cwd: "/course",
    quarto: "/bin/quarto",
    nativeArgv: ["tasks", "--profile", "student"],
    mode: "off",
  },
  outcome: {
    code: 23,
    signal: null,
    wallSeconds: 1.25,
    cpuUserSeconds: null,
    cpuSystemSeconds: null,
    peakRssKiB: null,
  },
  preparation: [],
  dataValid: true,
  quality,
  versions: { tool: "2.0.0", quarto: "1.11.5", deno: null, pandoc: null },
  git: null,
  collectionDirectory: "/tmp/course-perf/native-1",
  outputDirectory: "/course/.quarto/course-perf/runs/native-1",
  artifacts: { report: "report.md", stdout: "stdout.log", stderr: "stderr.log" },
} satisfies RunRecord;
const summary = {
  schema_version: 2,
  runId: "native-1",
  dataValid: true,
  quality,
  operations: [],
  counters: [],
} satisfies RunSummary;
const event = {
  schema_version: 1,
  experiment_id: "native-1",
  run_id: "native-1",
  process_id: "p",
  executor_id: "ts",
  sequence: 1,
  event: "counter",
  kind: "ast_walk",
  origin: "manual",
  clock_domain: "none",
  counter: { name: "walk_api_calls", value: 1, quality: "observed-exact" },
};

// Отказ границы metadata от v1 защищает raw от неявной миграции или пересохранения.
Deno.test("formats distinguish current metadata from raw v1", () => {
  assert.equal(validateRunRecord(run).schema_version, 2);
  assert.equal(validateRunSummary(summary).schema_version, 2);
  assert.equal(validateEvent(event).schema_version, 1);
  for (const version of [undefined, 1, 3, "2", null]) {
    assert.throws(() => validateRunRecord({ ...run, schema_version: version }), /schema_version/);
    assert.throws(
      () => validateRunSummary({ ...summary, schema_version: version }),
      /schema_version/,
    );
  }
  assert.throws(() => validateEvent({ ...event, schema_version: 2 }));
});

Deno.test("run metadata keeps unavailable resources explicit and separates staging from output", () => {
  const parsed = validateRunRecord(run);
  assert.equal(parsed.outcome.code, 23);
  assert.equal(parsed.outcome.cpuUserSeconds, null);
  assert.equal(parsed.git, null);
  assert.notEqual(parsed.collectionDirectory, parsed.outputDirectory);
  for (const field of ["cpuUserSeconds", "cpuSystemSeconds", "peakRssKiB", "signal"]) {
    const outcome: Record<string, unknown> = { ...run.outcome };
    delete outcome[field];
    assert.throws(() => validateRunRecord({ ...run, outcome }), new RegExp(field));
  }
  for (const field of ["collectionDirectory", "outputDirectory", "quality", "versions", "git"]) {
    const incomplete: Record<string, unknown> = { ...run };
    delete incomplete[field];
    assert.throws(() => validateRunRecord(incomplete), new RegExp(field));
  }
  for (
    const outcome of [
      { ...run.outcome, wallSeconds: -1 },
      { ...run.outcome, cpuUserSeconds: Infinity },
      { ...run.outcome, peakRssKiB: -1 },
      { ...run.outcome, code: 1.5 },
    ]
  ) assert.throws(() => validateRunRecord({ ...run, outcome }));
  assert.throws(() => validateRunRecord({ ...run, request: { ...run.request, mode: "unknown" } }));
});

Deno.test("summary counters retain executor scope, source and delta versus total", () => {
  const delta = {
    processId: "p",
    executorId: "ts",
    name: "walk_api_calls",
    value: 2,
    source: "event",
    semantics: "delta",
    quality: "observed-exact",
  };
  const total = { ...delta, source: "executor-summary", semantics: "total" };
  const parsed = validateRunSummary({ ...summary, counters: [delta, total] });
  assert.deepEqual(parsed.counters.map((c: { value: number }) => c.value), [2, 2]);
  for (
    const change of [
      { semantics: undefined },
      { source: "unknown" },
      { processId: "" },
      { executorId: undefined },
      { value: null },
      { quality: "unknown" },
    ]
  ) assert.throws(() => validateRunSummary({ ...summary, counters: [{ ...delta, ...change }] }));
});

Deno.test("run metadata validates provenance and preparation without changing native arguments", () => {
  const parsed = validateRunRecord({
    ...run,
    request: { ...run.request, nativeArgv: ["", "--", "$literal"], outputParent: "/measurements" },
    outcome: { ...run.outcome, signal: "SIGTERM", cpuUserSeconds: 0, peakRssKiB: 2048 },
    git: { root: "/course", head: "a".repeat(40), dirty: true },
    preparation: [{ kind: "bootstrap", path: "init.lua", sourceHash: "a", preparedHash: "b" }],
  });
  assert.deepEqual(parsed.request.nativeArgv, ["", "--", "$literal"]);
  assert.equal(parsed.outcome.signal, "SIGTERM");
  assert.equal(parsed.outcome.cpuUserSeconds, 0);
  assert.equal(parsed.outcome.peakRssKiB, 2048);
  assert.equal(parsed.git?.dirty, true);
  for (
    const change of [
      { dataValid: undefined },
      { request: { ...run.request, nativeArgv: [3] } },
      { outcome: { ...run.outcome, signal: "unknown" } },
      { preparation: [{ kind: "unknown", path: "init.lua", sourceHash: "a", preparedHash: "b" }] },
      { preparation: [{ kind: "bootstrap", path: "init.lua", sourceHash: "a" }] },
      { quality: { ...quality, droppedEvents: -1 } },
      { quality: { ...quality, incompleteSpans: 0.5 } },
      { quality: { ...quality, coverageComplete: undefined } },
      { quality: { ...quality, errors: [2] } },
      { versions: { ...run.versions, tool: "" } },
      { versions: { tool: "2.0.0", quarto: "1.11.6", pandoc: null } },
      { git: { root: "/course", head: "abbreviated", dirty: false } },
      { artifacts: { report: null } },
    ]
  ) assert.throws(() => validateRunRecord({ ...run, ...change }));
});

Deno.test("summary operations preserve separate clocks and unavailable self time", () => {
  const operation = {
    operationId: "collect",
    clockDomain: "monotonic_process",
    completed: 1,
    errors: 0,
    inclusiveMicroseconds: 12,
    selfMicroseconds: null,
    quality: "observed-exact",
  };
  const parsed = validateRunSummary({
    ...summary,
    operations: [operation, { ...operation, clockDomain: "process_cpu", inclusiveMicroseconds: 5 }],
  });
  assert.deepEqual(parsed.operations.map((o) => [o.clockDomain, o.inclusiveMicroseconds]), [
    ["monotonic_process", 12],
    ["process_cpu", 5],
  ]);
  assert.equal(parsed.operations[0].selfMicroseconds, null);
  for (
    const change of [
      { operationId: "" },
      { clockDomain: "wall" },
      { completed: -1 },
      { errors: 0.5 },
      { inclusiveMicroseconds: Infinity },
      { selfMicroseconds: undefined },
      { quality: "unknown" },
    ]
  ) {
    assert.throws(() =>
      validateRunSummary({ ...summary, operations: [{ ...operation, ...change }] })
    );
  }
});

Deno.test("common run metadata accepts isolated trace without narrowing it to a simple mode", () => {
  const parsed = validateRunRecord({ ...run, request: { ...run.request, mode: "trace" } });
  assert.equal(parsed.request.mode, "trace");
});

Deno.test("outcome escalation and combined PTY receipts are optional but validated", () => {
  assert.equal(validateRunRecord(run).outcome.escalated, undefined);
  assert.equal(
    validateRunRecord({
      ...run,
      outcome: { ...run.outcome, escalated: true, stdioMode: "pty-combined" },
    }).outcome.stdioMode,
    "pty-combined",
  );
  assert.throws(
    () => validateRunRecord({ ...run, outcome: { ...run.outcome, escalated: "yes" } }),
    /escalated/,
  );
  assert.throws(
    () => validateRunRecord({ ...run, outcome: { ...run.outcome, stdioMode: "combined" } }),
    /stdioMode/,
  );
});
