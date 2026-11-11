import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { PreparedVariant, Scenario } from "../../src/config/types.ts";
import { benchmarkPair } from "../../src/runner/benchmark.ts";
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
    const [control, candidate] = prepared;
    assert(control && candidate);
    const series = await benchmarkPair(s, control, candidate, {
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

Deno.test("benchmark rejects a known native zero when supervisor observation is invalid", async () => {
  const root = await Deno.makeTempDir({ prefix: "benchmark invalid measurement " });
  const output = join(root, "runs");
  const readDir = Deno.readDir;
  let injected = false;
  const completed = () => {
    try {
      for (const run of Deno.readDirSync(output)) {
        if (
          [...Deno.readDirSync(join(output, run.name))].some((entry) =>
            /^status-.*\.json$/.test(entry.name)
          )
        ) return true;
      }
    } catch { /* No completed native yet. */ }
    return false;
  };
  Deno.readDir = (path: string | URL) => {
    if (path === "/proc" && completed()) {
      injected = true;
      return {
        async *[Symbol.asyncIterator]() {
          throw new Deno.errors.PermissionDenied("benchmark proc observation unavailable");
        },
      };
    }
    return readDir(path);
  };
  try {
    const prepared: PreparedVariant = {
      root,
      variant: "candidate",
      manifest: {
        schema_version: 2,
        projectSource: "org/Fixture",
        replacements: [],
        experimentId: "e",
        sources: [],
        packages: [],
        runtime: {},
      },
    };
    const scenario: Scenario = {
      id: "invalid",
      cwd: ".",
      executable: "/bin/sh",
      args: ["-c", "sleep 30 >/dev/null 2>&1 & exit 0"],
      cachePolicy: "repeat-render",
      mode: "off",
      scope: { modules: [], extensions: [], strict: true },
      resources: { wall: true, cpu: false, peakRss: false },
    };
    await assert.rejects(
      () =>
        benchmarkPair(scenario, prepared, prepared, {
          pairs: 1,
          seed: 42,
          executeOptions: { outputRoot: output },
        }),
      /Прогрев непригоден: native=0, dataValid=false/,
    );
    assert(injected);
    const runs = [];
    for await (const run of readDir(output)) runs.push(run.name);
    assert.equal(runs.length, 1, "invalid warmup cannot create a comparative series");
    const record = JSON.parse(await Deno.readTextFile(join(output, runs[0]!, "run.json")));
    assert.equal(record.outcome.code, 0);
    assert.equal(record.dataValid, false);
    assert(
      record.quality.errors.some((message: string) =>
        message.includes("benchmark proc observation unavailable")
      ),
    );
  } finally {
    Deno.readDir = readDir;
    await Deno.remove(root, { recursive: true });
  }
});
