import { strict as assert } from "node:assert";
import { join } from "node:path";
import { normalizeRun } from "../../src/analysis/normalize.ts";
import type { Event } from "../../src/protocol/types.ts";
import { observePackages } from "../../src/runner/package-coverage.ts";

const event: Event = {
  schema_version: 1,
  experiment_id: "e",
  run_id: "r",
  process_id: "p",
  executor_id: "ts",
  sequence: 1,
  event: "counter",
  kind: "phase",
  origin: "manual",
  clock_domain: "none",
  counter: { name: "calls", value: 1, quality: "observed-exact" },
  attributes: { extension_id: "marked" },
};

Deno.test("наблюдения событий сохраняют атрибуцию и явный выбор без сканирования исходников", () => {
  const result = observePackages({ requested: ["marked", "absent"] }, [event, {
    ...event,
    executor_id: "lua",
    attributes: {},
    operation_id: "derived.phase",
  }], true);
  assert.deepEqual(result.requested, ["marked", "absent"]);
  assert.equal(result.observationStatus, "valid");
  assert.deepEqual(result.observations.map((o) => [o.extensionId, o.attribution, o.events]), [[
    "marked",
    "recorded",
    1,
  ], ["derived", "derived", 1]]);
  assert.deepEqual(observePackages(undefined, [], false), {
    observationStatus: "partial",
    observations: [],
  });
});

Deno.test("нормализация записывает действительные события без package inventory и не заявляет полноту", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "events"));
    await Deno.writeTextFile(
      join(root, "expectations.json"),
      JSON.stringify({ schema_version: 2, processes: [] }),
    );
    await Deno.writeTextFile(
      join(root, "coverage.json"),
      JSON.stringify({ complete: false, packageCoverage: { requested: ["marked", "absent"] } }),
    );
    await Deno.writeTextFile(
      join(root, "events/p.summary.json"),
      JSON.stringify({
        schema_version: 1,
        experiment_id: "e",
        run_id: "r",
        process_id: "p",
        executor_id: "ts",
        clock_domain: "monotonic_process",
        data_valid: true,
        dropped_events: 0,
        incomplete_spans: 0,
        counters: { calls: 1 },
      }),
    );
    await Deno.writeTextFile(join(root, "events/p.jsonl"), JSON.stringify(event) + "\n");
    assert.equal((await normalizeRun(root)).dataValid, true);
    const coverage = JSON.parse(await Deno.readTextFile(join(root, "coverage.json")));
    assert.equal(coverage.complete, false);
    assert.equal(coverage.packageCoverage.observationStatus, "valid");
    assert.equal(coverage.packageCoverage.observations[0].extensionId, "marked");
    assert.deepEqual(Object.keys(coverage.packageCoverage).sort(), [
      "observationStatus",
      "observations",
      "requested",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
