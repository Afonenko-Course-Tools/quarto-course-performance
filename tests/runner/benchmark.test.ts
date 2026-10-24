import { strict as assert } from "node:assert";
import { join } from "node:path";
import { benchmarkPair } from "../../src/runner/benchmark.ts";
import type { PreparedVariant, Scenario } from "../../src/config/types.ts";
Deno.test("benchmark excludes warmups, alternates AB/BA and creates independent runs with equal clean state", async () => {
  const root = await Deno.makeTempDir();
  try {
    const manifest = {
      schema_version: 2 as const,
      projectSource: "org/Fixture",
      replacements: [],
      experimentId: "e",
      sources: [],
      packages: [],
      runtime: {},
    };
    const prepared: PreparedVariant[] = [];
    for (const variant of ["clean-control", "candidate"] as const) {
      const dir = join(root, variant);
      await Deno.mkdir(dir);
      await Deno.writeTextFile(
        join(dir, "fake.ts"),
        "try{await Deno.stat('.out');throw new Error('stale output');}catch(e){if(!(e instanceof Deno.errors.NotFound))throw e;}await Deno.mkdir('.out');console.log('ok');",
      );
      prepared.push({ variant, root: dir, manifest });
    }
    const s: Scenario = {
      id: "fixture",
      cwd: ".",
      executable: Deno.execPath(),
      args: ["run", "-A", "fake.ts"],
      cachePolicy: "clean-output",
      mode: "off",
      scope: { modules: [], extensions: [], strict: true },
      resources: { wall: true, cpu: false, peakRss: false },
    };
    const series = await benchmarkPair(s, prepared[0], prepared[1], {
      pairs: 3,
      seed: 42,
      executeOptions: { outputRoot: join(root, "runs"), cleanPaths: [".out"] },
    });
    assert.deepEqual(series.pairs.map((p) => p.order), ["AB", "BA", "AB"]);
    assert.equal(new Set(series.pairs.flatMap((p) => [p.controlRunId, p.candidateRunId])).size, 6);
    const dirs = [];
    for await (const e of Deno.readDir(join(root, "runs"))) dirs.push(e.name);
    assert.equal(dirs.length, 8);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("benchmark uses ten pairs by default for any scenario name", async () => {
  const root = await Deno.makeTempDir();
  try {
    const prepared = {
      variant: "candidate" as const,
      root,
      manifest: {
        schema_version: 2 as const,
        projectSource: "org/Course",
        replacements: [],
        experimentId: "e",
        sources: [],
        packages: [],
        runtime: {},
      },
    };
    const scenario: Scenario = {
      id: "java-full-custom",
      cwd: ".",
      executable: "/usr/bin/true",
      args: [],
      cachePolicy: "repeat-render",
      mode: "off",
      scope: { modules: [], extensions: [], strict: true },
      resources: { wall: true, cpu: false, peakRss: false },
    };
    const result = await benchmarkPair(scenario, prepared, prepared, {
      seed: 42,
      executeOptions: { outputRoot: join(root, "runs") },
    });
    assert.equal(result.pairs.length, 10);
    assert.equal((await Array.fromAsync(Deno.readDir(join(root, "runs")))).length, 22);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
