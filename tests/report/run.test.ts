import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";
import { nativeCommandMarkdown, writeRunArtifacts } from "../../src/report/run.ts";
import { type RunRecord, validateRunRecord, validateRunSummary } from "../../src/report/types.ts";

import { regressionRuns } from "./fixtures/perfetto/regressions.ts";
import { pair, run } from "./fixtures/perfetto/control.ts";
import { traces } from "../../src/report/perfetto.ts";
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
    r.preparedScripts = [{
      kind: "bootstrap",
      path: "/original/bootstrap",
    }];
    const published = await writeRunArtifacts(dir, r);
    assert.equal(published.record, r);
    assert.equal(published.directory, dir);
    const moved = join(root, "moved");
    await Deno.rename(dir, moved);
    const metadata = validateRunRecord(
      JSON.parse(await Deno.readTextFile(join(moved, "run.json"))),
    );
    assert.equal(metadata.collectionDirectory, dir);
    assert.equal(metadata.preparedScripts[0].path, "/original/bootstrap");
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
  const timing = { clock_domain: "monotonic_process", scope: "launcher-spawn-to-status" };
  const child = "17508e10-52e6-4644-8eae-db2333d0c5f5";
  const parent = "8094c765-815e-4278-b051-6a5fbb72bb59";
  const commands = nativeCommandMarkdown([
    {
      kind: "deno",
      argv: [
        "run",
        "--allow-all",
        "--v8-flags=private",
        "/private/quarto.js",
        "inspect",
        "secret-token",
      ],
      cwd: "/private/course",
      process_id: child,
      parent_process_id: parent,
      parent_link: "confirmed",
      exit_code: 0,
      signal: null,
      native_command: { ...timing, wall_seconds: 2.5 },
    },
    { kind: "pandoc", process_id: "old", exit_code: null, signal: "SIGTERM" },
    {
      kind: "deno",
      argv: ["run", "other.ts", "/private/quarto.js", "render"],
      native_command: { ...timing, wall_seconds: 0 },
    },
    {
      kind: "deno",
      argv: ["run", "--unknown-flag", "quarto.js", "render"],
      process_id: "/private/secret-token",
      parent_process_id: "secret-parent",
      parent_link: "confirmed",
      native_command: { ...timing, wall_seconds: NaN },
    },
    { kind: "pandoc", native_command: { ...timing, wall_seconds: Infinity } },
    { kind: "pandoc", native_command: { ...timing, wall_seconds: -1 } },
    {
      kind: "pandoc",
      native_command: { ...timing, clock_domain: "process_cpu", wall_seconds: 999 },
    },
    { kind: "deno", native_command: { ...timing, scope: "different-scope", wall_seconds: 888 } },
    { kind: "pandoc", native_command: { wall_seconds: 777 } },
  ]).join("\n");
  assert(commands.includes(`Quarto inspect | 2.500 | 0 | — | ${child} | ${parent}`));
  assert.match(commands, /Pandoc \| неизвестно \| неизвестно \| SIGTERM/);
  assert.match(commands, /Deno \| 0\.000/);
  assert.match(commands, /Deno \| неизвестно/);
  assert.match(commands, /Pandoc \| неизвестно \| неизвестно \| неизвестно/);
  assert.match(commands, /не показан \| не показан/);
  assert(commands.indexOf("2.500") < commands.indexOf("0.000"));
  assert(commands.indexOf("0.000") < commands.indexOf("SIGTERM"));
  assert(!/secret|private|other\.ts|Quarto render|NaN|Infinity|999|888|777/.test(commands));
  assert.match(commands, /Покрытие частичное/);
  assert.match(commands, /нельзя складывать/);
  assert.deepEqual(nativeCommandMarkdown([]), []);
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

Deno.test("trace bundle and versioned export survive staging with relative existing links", async () => {
  const root = await Deno.makeTempDir();
  try {
    const stage = join(root, "stage folder"), final = join(root, "final folder");
    await Deno.mkdir(stage);
    const r = record(stage);
    r.request.mode = "trace";
    const normalized = run([
      ...pair("wall", 1, 9),
      ...pair("local", 2, 8, { executor_id: "local" }),
      ...pair("lua", 3, 7, { clock_domain: "process_cpu", executor_id: "lua" }),
    ]);
    r.runId = normalized.runId;
    normalized.executors[`${normalized.events[0].process_id}/local`].calibration = undefined;
    await Deno.mkdir(join(stage, "processes"));
    await Deno.writeTextFile(
      join(stage, "processes/p.json"),
      JSON.stringify({ process_id: normalized.events[0].process_id, parent_process_id: "root" }),
    );
    const before = JSON.stringify(normalized);
    await writeRunArtifacts(stage, r, normalized);
    await Deno.rename(stage, final);
    const bundle = traces(normalized, [{
      process_id: normalized.events[0].process_id,
      parent_process_id: "root",
    }]);
    for (
      const [file, expected] of [["wall.trace.json", bundle.wall], [
        "lua-cpu.trace.json",
        bundle.luaCpu,
      ], ...bundle.localWall.map((x) => [x.fileName, x.trace])] as const
    ) {
      assert.deepEqual(JSON.parse(await Deno.readTextFile(join(final, String(file)))), expected);
    }
    const sidecar = JSON.parse(await Deno.readTextFile(join(final, "export.json")));
    assert.equal(sidecar.schema_version, 1);
    assert.equal(sidecar.format, "chrome-trace-event-json");
    assert.equal(sidecar.run_id, normalized.runId);
    assert.equal(sidecar.data_valid, true);
    assert.equal(sidecar.coverage_complete, false);
    assert.equal(sidecar.files.length, 3);
    assert(sidecar.files.some((f: { clock: string }) => f.clock === "local-wall"));
    assert(
      sidecar.executors.some((e: { process_id: string; executor_id: string }) =>
        e.process_id === normalized.events[0].process_id && e.executor_id === "local"
      ),
    );
    const report = await Deno.readTextFile(join(final, "report.md"));
    assert.match(report, /общая wall-шкала/);
    assert.match(report, /локальная wall-шкала/);
    assert.match(report, /Lua CPU/);
    assert.match(report, /run\.json: completion\.native\.peakRssKiB/);
    for (const link of report.matchAll(/\]\(([^)]+)\)/g)) {
      await Deno.stat(resolve(final, decodeURI(link[1])));
    }
    assert.equal(JSON.stringify(normalized), before);
    await assert.rejects(() => Deno.stat(join(final, "runs")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("report links only existing CPU profiles", async () => {
  const root = await Deno.makeTempDir();
  try {
    const r = record(root);
    r.request.mode = "cpu";
    for (const process of ["present", "with spaces"]) {
      await Deno.mkdir(join(root, "profiles", process), { recursive: true });
      await Deno.writeTextFile(
        join(root, "profiles", process, "cpu.cpuprofile"),
        JSON.stringify({ nodes: [], startTime: 0, endTime: 1 }),
      );
    }
    await Deno.mkdir(join(root, "profiles/missing"), { recursive: true });
    await writeRunArtifacts(root, r);
    const report = await Deno.readTextFile(join(root, "report.md"));
    assert(report.includes("profiles/present/cpu.cpuprofile"));
    assert(!report.includes("profiles/missing/cpu.cpuprofile"));
    assert(report.includes("profiles/with%20spaces/cpu.cpuprofile"));
    for (const link of report.matchAll(/\]\(([^)]+)\)/g)) {
      await Deno.stat(resolve(root, decodeURI(link[1])));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("off with normalized metadata never promises an internal trace", async () => {
  const root = await Deno.makeTempDir();
  try {
    await writeRunArtifacts(root, record(root), run([]));
    await assert.rejects(() => Deno.stat(join(root, "wall.trace.json")), Deno.errors.NotFound);
    assert(!(await Deno.readTextFile(join(root, "report.md"))).includes("wall.trace.json"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("common builder writes corrected clocks relationships and preserved quality", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const [name, input] of Object.entries(regressionRuns())) {
      const dir = join(root, name), rec = record(dir, input.runId);
      rec.request.mode = "trace";
      rec.dataValid = input.dataValid;
      rec.quality = input.quality;
      const raw = JSON.stringify(input.events);
      await writeRunArtifacts(dir, rec, input);
      const expected = traces(input);
      for (
        const [file, trace] of [["wall.trace.json", expected.wall], [
          "lua-cpu.trace.json",
          expected.luaCpu,
        ], ...expected.localWall.map((l) => [l.fileName, l.trace])] as const
      ) {
        assert.deepEqual(JSON.parse(await Deno.readTextFile(join(dir, String(file)))), trace);
      }
      const sidecar = JSON.parse(await Deno.readTextFile(join(dir, "export.json")));
      assert.equal(sidecar.data_valid, input.dataValid);
      assert.deepEqual(sidecar.quality, input.quality);
      const summary = validateRunSummary(
        JSON.parse(await Deno.readTextFile(join(dir, "summary.json"))),
      );
      assert.equal(summary.operations.length, input.events.length / 2);
      assert.equal(JSON.stringify(input.events), raw);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
