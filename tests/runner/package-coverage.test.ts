import { strict as assert } from "node:assert";
import { join } from "node:path";
import { normalizeRun } from "../../src/analysis/normalize.ts";
import { assetPath } from "../../src/assets.ts";
import { treeHash } from "../../src/sources/snapshot.ts";
import { prepareRenderDiagnostic } from "../../src/runner/diagnostic.ts";

Deno.test("package coverage inventories the selected nested project, marking and recorded observations", async () => {
  const root = await Deno.makeTempDir();
  try {
    const project = join(root, "nested");
    for (const [scope, id] of [[root, "parent"], [project, "marked"], [project, "unmarked"]]) {
      const pkg = join(scope, "_extensions/org", id);
      await Deno.mkdir(pkg, { recursive: true });
      await Deno.writeTextFile(join(pkg, "_extension.yml"), `title: ${id}\n`);
      await Deno.mkdir(join(pkg, "observability"));
      await Deno.copyFile(assetPath("bridge/bridge.lua"), join(pkg, "observability/bridge.lua"));
      await Deno.writeTextFile(
        join(pkg, "filter.lua"),
        id === "marked"
          ? 'local metrics = require("./observability/bridge").create_metrics("marked",1)\n'
          : `-- require("./observability/bridge").create_metrics("unmarked",1)
local example = 'require("./observability/bridge").create_metrics("unmarked",1)'
return {}
`,
      );
    }
    const before = await treeHash(root);
    const prepared = await prepareRenderDiagnostic(
      { cwd: project, quarto: Deno.env.get("QUARTO") ?? "quarto", nativeArgv: [], mode: "summary" },
      { projectRoot: project, kind: "project" },
      join(root, "diagnostic"),
    );
    const coverage = prepared.coverage as unknown as Record<string, any>;
    assert(coverage.packageCoverage, "Missing physical package inventory");
    const packages = coverage.packageCoverage.packages;
    assert.deepEqual(packages.map((p: any) => p.extensionId).sort(), ["marked", "unmarked"]);
    assert.equal(packages.find((p: any) => p.extensionId === "marked").instrumentation, "detected");
    assert.equal(
      packages.find((p: any) => p.extensionId === "unmarked").instrumentation,
      "not-detected",
    );
    assert.equal(coverage.packageCoverage.observationStatus, "pending");
    await Deno.remove(join(root, "diagnostic"), { recursive: true });
    assert.equal(await treeHash(root), before, "Inventory must not change functional inputs");
    const modulePath = "../../src/runner/package-coverage.ts";
    const module = await import(modulePath);
    const inventory = await module.collectPackageCoverage(project, [
      "marked",
      "unmarked",
      "absent",
    ]);
    assert.deepEqual(inventory.requested.map((p: any) => [p.extensionId, p.installed]), [
      ["marked", true],
      ["unmarked", true],
      ["absent", false],
    ]);
    const run = join(root, "run");
    await Deno.mkdir(join(run, "events"), { recursive: true });
    await Deno.writeTextFile(
      join(run, "expectations.json"),
      JSON.stringify({ schema_version: 2, processes: [] }),
    );
    await Deno.writeTextFile(
      join(run, "coverage.json"),
      JSON.stringify({ complete: false, packageCoverage: inventory }),
    );
    await Deno.writeTextFile(
      join(run, "events/p.summary.json"),
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
    await Deno.writeTextFile(
      join(run, "events/p.jsonl"),
      JSON.stringify({
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
      }) + "\n",
    );
    assert.equal((await normalizeRun(run)).dataValid, true);
    const current = JSON.parse(await Deno.readTextFile(join(run, "coverage.json"))).packageCoverage;
    assert.equal(current.observationStatus, "valid");
    assert.deepEqual(
      current.observations.map((o: any) => [o.extensionId, o.attribution, o.events]),
      [["marked", "recorded", 1]],
    );
    assert.deepEqual(current.packages, inventory.packages);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("normalizing old coverage preserves unknown package installation instead of inventing history", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(root, "expectations.json"),
      JSON.stringify({ schema_version: 2, processes: [] }),
    );
    await Deno.writeTextFile(join(root, "coverage.json"), JSON.stringify({ complete: false }));
    await normalizeRun(root);
    const coverage = JSON.parse(await Deno.readTextFile(join(root, "coverage.json")));
    assert.equal(coverage.packageCoverage?.inventoryStatus, "unknown");
    assert.equal(coverage.packageCoverage.packages, null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("static package marking ignores examples and records unresolved bindings as unknown", async () => {
  const { collectPackageCoverage, observePackages } = await import(
    "../../src/runner/package-coverage.ts"
  );
  const root = await Deno.makeTempDir();
  try {
    for (const id of ["marked", "examples", "uncertain"]) {
      const pkg = join(root, "_extensions/org", id);
      await Deno.mkdir(join(pkg, "observability"), { recursive: true });
      await Deno.writeTextFile(join(pkg, "_extension.yml"), `title: ${id}\n`);
      await Deno.copyFile(assetPath("bridge/bridge.ts"), join(pkg, "observability/bridge.ts"));
      await Deno.writeTextFile(
        join(pkg, "filter.ts"),
        id === "marked"
          ? 'import {createMetrics as __createMetrics} from "./observability/bridge.ts";\nconst metrics = __createMetrics("marked");'
          : id === "examples"
          ? `import {createMetrics as __createMetrics} from "./observability/bridge.ts";
// __createMetrics("examples");
/* __createMetrics("examples"); */
const sample = '__createMetrics("examples")';
const regexp = /__createMetrics("examples")/;
const template = \`__createMetrics("examples")\`;
`
          : 'import {createMetrics} from "./unknown.ts";\nconst metrics=createMetrics("uncertain");',
      );
    }
    const coverage = await collectPackageCoverage(root);
    assert.deepEqual(coverage.packages!.map((p) => [p.extensionId, p.instrumentation]), [
      ["examples", "not-detected"],
      ["marked", "detected"],
      ["uncertain", "unknown"],
    ]);
    assert.equal(coverage.packages![1].instrumentationEvidence[0].kind, "canonical-abi1-binding");
    const copy = join(root, "nested/_extensions/org/marked");
    await Deno.mkdir(copy, { recursive: true });
    await Deno.writeTextFile(join(copy, "_extension.yml"), "title: marked\n");
    const duplicates = await collectPackageCoverage(root);
    const event = {
      schema_version: 1,
      experiment_id: "e",
      run_id: "r",
      process_id: "p",
      executor_id: "ts",
      sequence: 1,
      event: "begin",
      kind: "phase",
      origin: "manual",
      clock_domain: "monotonic_process",
      operation_id: "marked.phase",
      timestamp_us: 1,
      span_id: "s",
    } as const;
    const observed = observePackages(duplicates, [event], true);
    assert.equal(observed.packages!.filter((p) => p.extensionId === "marked").length, 2);
    assert.deepEqual(observed.observations.map((o) => [o.extensionId, o.attribution]), [[
      "marked",
      "derived",
    ]]);
    assert(
      observed.packages!.every((p) => !("observed" in p)),
      "Extension ID alone cannot select a physical copy",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
