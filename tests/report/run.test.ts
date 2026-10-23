import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";
import { writeRunArtifacts } from "../../src/report/run.ts";
import { type RunRecord, validateRunRecord, validateRunSummary } from "../../src/report/types.ts";

import { record } from "./fixture.ts";

Deno.test("single off report is versioned, portable and does not invent diagnostic observations", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = join(root, "collection");
    await Deno.mkdir(dir);
    await Deno.writeTextFile(join(dir, "stdout.log"), "out");
    await Deno.writeTextFile(join(dir, "stderr.log"), "err");
    await Deno.mkdir(join(dir, "events"));
    const raw = '{"raw":"/original/collection"}\n';
    await Deno.writeTextFile(join(dir, "events/raw.jsonl"), raw);
    const r = record(dir);
    r.preparation = [{
      kind: "bootstrap",
      path: "/original/bootstrap",
      sourceHash: "s",
      preparedHash: "p",
    }];
    await writeRunArtifacts(dir, r);
    const moved = join(root, "moved");
    await Deno.rename(dir, moved);
    const metadata = validateRunRecord(
      JSON.parse(await Deno.readTextFile(join(moved, "run.json"))),
    );
    assert.equal(metadata.collectionDirectory, dir);
    assert.equal(metadata.outputDirectory, "/final/test");
    assert.equal(metadata.preparation[0].path, "/original/bootstrap");
    const summary = validateRunSummary(
      JSON.parse(await Deno.readTextFile(join(moved, "summary.json"))),
    );
    assert.deepEqual(summary.operations, []);
    assert.deepEqual(summary.counters, []);
    assert.equal(summary.quality.coverageComplete, false);
    assert.equal(await Deno.readTextFile(join(moved, "events/raw.jsonl")), raw);
    const markdown = await Deno.readTextFile(join(moved, "report.md"));
    assert(markdown.includes("7"));
    for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      assert(!match[1].startsWith("/"));
      await Deno.stat(resolve(moved, match[1]));
    }
    await assert.rejects(() => Deno.stat(join(moved, "runs")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("run summary retains event deltas and executor totals as separate observations", async () => {
  const root = await Deno.makeTempDir();
  try {
    const r = record(root);
    await writeRunArtifacts(root, r, {
      runId: "test",
      dataValid: true,
      quality: r.quality,
      executors: { "p/ts": { process_id: "p", executor_id: "ts", counters: { calls: 2 } } },
      events: [{
        schema_version: 1,
        experiment_id: "e",
        run_id: "test",
        process_id: "p",
        executor_id: "ts",
        sequence: 1,
        event: "counter",
        kind: "ast_walk",
        origin: "manual",
        clock_domain: "none",
        counter: { name: "calls", value: 1, quality: "observed-exact" },
      }],
    });
    const summary = validateRunSummary(
      JSON.parse(await Deno.readTextFile(join(root, "summary.json"))),
    );
    assert.deepEqual(summary.counters.map((c) => [c.name, c.value, c.source, c.semantics]), [[
      "calls",
      1,
      "event",
      "delta",
    ], ["calls", 2, "executor-summary", "total"]]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
