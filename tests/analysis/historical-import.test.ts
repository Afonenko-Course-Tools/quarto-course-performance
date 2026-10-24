import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { normalizeRun } from "../../src/analysis/normalize.ts";
import { validateRunRecord, validateRunSummary } from "../../src/report/types.ts";
import { hashFile } from "../../src/sources/snapshot.ts";

async function json(path: string, value: unknown) {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(value) + "\n");
}
async function inventory(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  async function visit(path: string) {
    const s = await Deno.lstat(path);
    result.push([
      path.slice(root.length),
      s.mode,
      s.isSymlink ? await Deno.readLink(path) : s.isFile ? await hashFile(path) : "directory",
    ]);
    if (s.isDirectory) {
      const names = [];
      for await (const e of Deno.readDir(path)) names.push(e.name);
      for (const name of names.sort()) await visit(join(path, name));
    }
  }
  await visit(root);
  return result;
}
async function fixture(root: string, version?: number, damaged = false, code = 0) {
  await json(join(root, "candidate.manifest.json"), {
    schema_version: version,
    experimentId: "history-e",
    sources: [],
    packages: [],
    runtime: {},
  });
  const run = join(root, "runs/r");
  await json(join(run, "run.json"), {
    schema_version: version,
    runId: "r",
    experimentId: "history-e",
    scenario: "old",
    variant: "candidate",
    mode: "trace",
    argv: ["/old/quarto", "render", "file with spaces.qmd"],
    cwd: "/old/project with spaces",
    buildExitCode: code,
    wallSeconds: 1.25,
    signal: null,
    dataValid: !damaged,
    preparation: [],
    resources: { cpu_user_seconds: null, cpu_system_seconds: null, peak_rss_kib: null },
  });
  await json(join(run, "mode.json"), { mode: "trace", runId: "r", experimentId: "history-e" });
  await json(join(run, "coverage.json"), { complete: false, original: "unchanged" });
  await json(join(run, "expectations.json"), { schema_version: 2, processes: [] });
  await json(join(run, "processes/p.json"), {
    process_id: "p",
    exit_code: code,
    signal: null,
    expectation: {
      process_id: "p",
      agent: "ts",
      requested: true,
      supported: true,
      activated: true,
      executed: true,
      summary_path: "events/p/ts.summary.json",
    },
  });
  await json(join(run, "events/p/ts.summary.json"), {
    schema_version: 1,
    experiment_id: "history-e",
    run_id: "r",
    process_id: "p",
    executor_id: "ts",
    clock_domain: "monotonic_process",
    data_valid: true,
    dropped_events: 0,
    incomplete_spans: 0,
    counters: {},
  });
  const events = [1, 2, ...(damaged ? [3, 4] : [])].map((sequence) => ({
    schema_version: 1,
    experiment_id: sequence < 3 ? "history-e" : "foreign",
    run_id: "r",
    process_id: "p",
    executor_id: "ts",
    sequence,
    event: sequence % 2 ? "begin" : "end",
    kind: "phase",
    span_id: sequence < 3 ? "good" : "bad",
    operation_id: sequence < 3 ? "good" : "bad",
    origin: "manual",
    clock_domain: "monotonic_process",
    timestamp_us: sequence * 100,
    status: sequence % 2 ? undefined : "ok",
    attributes: { source_path: join(root, "original.ts") },
  }));
  await Deno.writeTextFile(
    join(run, "events/p/ts.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  await Deno.chmod(join(run, "events/p/ts.jsonl"), 0o440);
  await Deno.writeTextFile(join(root, "report.md"), "old report");
  await Deno.writeTextFile(join(root, "summary.json"), "[]\n");
  await Deno.symlink("report.md", join(root, "old-report-link"));
  return run;
}
async function cli(root: string, command: string, ...args: string[]) {
  return await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      new URL("../../src/cli.ts", import.meta.url).pathname,
      "experiment",
      command,
      "--workspace",
      root,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
    env: { QUARTO: "/missing-native-command", PATH: "/missing" },
  }).output();
}
Deno.test("historical read-only normalization leaves expectations and coverage receipts intact", async () => {
  const root = await Deno.makeTempDir();
  try {
    const run = await fixture(root);
    const before = await inventory(root);
    const result = await normalizeRun(run, { readOnly: true });
    assert.equal(result.dataValid, true);
    assert.deepEqual(await inventory(root), before);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("explicit historical CLI report and verify derive v2 artifacts without modifying history", async () => {
  const root = await Deno.makeTempDir({ prefix: "history with spaces " });
  try {
    for (const version of [undefined, 1]) {
      const source = join(root, `source ${version}`);
      const run = await fixture(source, version);
      const before = await inventory(source);
      for (const command of ["report", "verify"]) {
        const output = join(root, `derived ${version} ${command}`);
        const out = await cli(source, command, "--import-historical", "--output", output);
        assert.equal(out.code, 0, new TextDecoder().decode(out.stderr));
        assert.deepEqual(await inventory(source), before);
        const record = validateRunRecord(
          JSON.parse(await Deno.readTextFile(join(output, "runs/r/run.json"))),
        );
        assert.equal(record.collectionDirectory, run);
        assert.equal(record.outputDirectory, join(output, "runs/r"));
        assert.equal(record.outcome.cpuUserSeconds, null);
        assert.equal(record.git, null);
        assert.deepEqual(record.request.nativeArgv, ["file with spaces.qmd"]);
        const summary = validateRunSummary(
          JSON.parse(await Deno.readTextFile(join(output, "runs/r/summary.json"))),
        );
        assert.equal(summary.operations[0].inclusiveMicroseconds, 100);
        assert.equal(
          JSON.parse(await Deno.readTextFile(join(output, "summary.json"))).schema_version,
          2,
        );
        const provenance = JSON.parse(
          await Deno.readTextFile(join(output, "import-provenance.json")),
        );
        assert.equal(provenance.sourceDirectory, source);
        assert.equal(
          provenance.manifest.sha256,
          await hashFile(join(source, "candidate.manifest.json")),
        );
        assert.equal(provenance.runs[0].sha256, await hashFile(join(run, "run.json")));
        assert.equal(
          await hashFile(join(output, "runs/r/events/p/ts.jsonl")),
          await hashFile(join(run, "events/p/ts.jsonl")),
        );
        for (const report of [join(output, "report.md"), join(output, "runs/r/report.md")]) {
          for (const match of (await Deno.readTextFile(report)).matchAll(/\]\(([^)]+)\)/g)) {
            await Deno.stat(join(dirname(report), decodeURI(match[1])));
          }
        }
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("historical API guards reject overlapping aliases, occupied output and unknown schemas before writes", async () => {
  const { importHistoricalExperiment } = await import("../../src/analysis/report.ts");
  const root = await Deno.makeTempDir();
  try {
    const source = join(root, "source");
    await fixture(source);
    await Deno.symlink(source, join(root, "alias"));
    const occupied = join(root, "occupied");
    await json(join(occupied, "keep.json"), { keep: true });
    const before = await inventory(root);
    for (
      const output of [source, join(source, "new"), root, join(root, "alias/new"), occupied, ""]
    ) {
      await assert.rejects(() => importHistoricalExperiment(source, output), /output|Output/);
      assert.deepEqual(await inventory(root), before);
    }
    const original = JSON.parse(await Deno.readTextFile(join(source, "runs/r/run.json")));
    for (
      const invalid of [
        { ...original, schema_version: 99 },
        { ...original, wallSeconds: undefined },
        { ...original, buildExitCode: undefined },
        { ...original, argv: undefined },
        { ...original, runId: "../outside" },
      ]
    ) {
      await json(join(source, "runs/r/run.json"), invalid);
      const snapshot = await inventory(root);
      await assert.rejects(
        () => importHistoricalExperiment(source, join(root, "new output")),
        /schema|metadata|argv|runId/,
      );
      assert.deepEqual(await inventory(root), snapshot);
    }
    await json(join(source, "runs/r/run.json"), original);
    await json(join(source, "candidate.manifest.json"), {
      schema_version: 99,
      experimentId: "history-e",
      sources: [],
      packages: [],
      runtime: {},
    });
    const snapshot = await inventory(root);
    await assert.rejects(
      () => importHistoricalExperiment(source, join(root, "new output")),
      /schema/,
    );
    assert.deepEqual(await inventory(root), snapshot);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("historical API and CLI preserve partial valid pairs and native failure priority", async () => {
  const { importHistoricalExperiment } = await import("../../src/analysis/report.ts");
  const root = await Deno.makeTempDir();
  try {
    for (const code of [0, 7]) {
      const source = join(root, `source${code}`);
      await fixture(source, 1, true, code);
      const before = await inventory(source);
      const output = join(root, `api${code}`);
      const result = await importHistoricalExperiment(source, output);
      assert.equal(result.exitCode, code ? 3 : 4);
      assert.equal(result.dataValid, false);
      assert.deepEqual(await inventory(source), before);
      const record = validateRunRecord(
        JSON.parse(await Deno.readTextFile(join(output, "runs/r/run.json"))),
      );
      assert.equal(record.outcome.code, code);
      assert.equal(record.importProvenance!.sourceStatus.buildExitCode, code);
      const summary = validateRunSummary(
        JSON.parse(await Deno.readTextFile(join(output, "runs/r/summary.json"))),
      );
      assert.deepEqual(
        summary.operations.map((o) => [o.operationId, o.inclusiveMicroseconds, o.quality]),
        [["good", 100, "partial"]],
      );
      assert.equal(summary.importProvenance!.adapterVersion, "experiment-history-v1");
      for (const command of ["report", "verify"]) {
        const out = await cli(
          source,
          command,
          "--import-historical",
          "--output",
          join(root, `${command}${code}`),
        );
        assert.equal(out.code, code ? 3 : 4, new TextDecoder().decode(out.stderr));
        assert.deepEqual(await inventory(source), before);
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("historical CLI requires explicit adapter plus output and rejects live command flags", async () => {
  const root = await Deno.makeTempDir();
  try {
    await fixture(root);
    const before = await inventory(root);
    for (const command of ["report", "verify"]) {
      for (
        const args of [[], ["--import-historical"], ["--output", "/tmp/unused-history-output"], [
          "--import-historical",
          "true",
          "--output",
          "/tmp/unused-history-output",
        ]]
      ) {
        const out = await cli(root, command, ...args);
        assert.equal(out.code, 2);
        assert.deepEqual(await inventory(root), before);
      }
    }
    for (const command of ["sources", "freeze", "run", "benchmark", "capabilities"]) {
      const out = await cli(
        root,
        command,
        "--import-historical",
        "--output",
        "/tmp/unused-history-output",
      );
      assert.equal(out.code, 2);
      assert.match(new TextDecoder().decode(out.stderr), /только report\/verify/);
      assert.deepEqual(await inventory(root), before);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("historical preflight validates per-run manifest and consumed benchmark shape before output", async () => {
  const { importHistoricalExperiment } = await import("../../src/analysis/report.ts");
  const root = await Deno.makeTempDir();
  try {
    const source = join(root, "source");
    const run = await fixture(source);
    await json(join(run, "manifest.json"), {
      schema_version: 99,
      experimentId: "history-e",
      sources: [],
      packages: [],
      runtime: {},
    });
    let before = await inventory(root);
    await assert.rejects(() => importHistoricalExperiment(source, join(root, "output")), /schema/);
    assert.deepEqual(await inventory(root), before);
    await Deno.remove(join(run, "manifest.json"));
    await json(join(source, "benchmarks/broken.json"), { complete: true });
    before = await inventory(root);
    await assert.rejects(
      () => importHistoricalExperiment(source, join(root, "output")),
      /benchmark/,
    );
    assert.deepEqual(await inventory(root), before);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("historical adapter never relabels arbitrary executable render commands as Quarto", async () => {
  const { importHistoricalExperiment } = await import("../../src/analysis/report.ts");
  const root = await Deno.makeTempDir();
  try {
    const source = join(root, "source");
    const run = await fixture(source);
    const metadata = JSON.parse(await Deno.readTextFile(join(run, "run.json")));
    await json(join(run, "run.json"), { ...metadata, argv: ["python3", "render", "page.qmd"] });
    const before = await inventory(root);
    await assert.rejects(
      () => importHistoricalExperiment(source, join(root, "output")),
      /Quarto|argv/,
    );
    assert.deepEqual(await inventory(root), before);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("historical aggregate does not retain a complete coverage claim after invalid raw data", async () => {
  const { importHistoricalExperiment } = await import("../../src/analysis/report.ts");
  const root = await Deno.makeTempDir();
  try {
    const source = join(root, "source");
    const run = await fixture(source, 1, true);
    await json(join(run, "coverage.json"), { complete: true });
    const before = await inventory(source);
    const output = join(root, "output");
    await importHistoricalExperiment(source, output);
    assert.equal(
      JSON.parse(await Deno.readTextFile(join(output, "coverage.json")))[0].complete,
      false,
    );
    assert.deepEqual(await inventory(source), before);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
