import { strict as assert } from "node:assert";
import { join } from "node:path";
import { prepareRunStorage } from "../src/runner/storage.ts";
import { executeScenario } from "../src/runner/execute.ts";
import { writeExperimentReport } from "../src/analysis/report.ts";
import { traces } from "../src/report/perfetto.ts";
import { operationTotals } from "../src/report/run.ts";
import { normalizeRun, validatedIntervals } from "../src/analysis/normalize.ts";
import { validateRunRecord, validateRunSummary } from "../src/report/types.ts";
import type { PreparedVariant, Scenario } from "../src/config/types.ts";
const manifest = {
  schema_version: 2 as const,
  projectSource: "org/Fixture",
  replacements: [],
  experimentId: "e",
  sources: [],
  packages: [],
  runtime: {},
};
const quality = { droppedEvents: 0, incompleteSpans: 0, coverageComplete: false, errors: [] };
Deno.test("W-F1 damaged requested diagnostics return 4, native errors retain priority", async () => {
  const root = await Deno.makeTempDir();
  try {
    const executable = join(root, "quarto");
    await Deno.writeTextFile(
      executable,
      `#!/bin/sh
if [ "$1" = inspect ]; then printf '%s\\n' '{"dir":"${root}","files":{"config":[]}}'; exit; fi
if [ "$1" = --version ] || [ "$1" = --paths ]; then exec /usr/bin/quarto "$@"; fi
if [ "$FIX_DAMAGE" = yes ]; then printf '%s\\n' '{"schema_version":2,"processes":[{"process_id":"fixture","agent":"ts","requested":true,"supported":true,"activated":true,"executed":true,"summary_path":"events/fixture/ts.summary.json"}]}' > "$COURSE_PERF_OUTPUT_DIR/expectations.json"; fi
if [ "$FIX_SIGNAL" = yes ]; then kill -TERM $$; fi
exit \${FIX_EXIT:-0}
`,
    );
    await Deno.chmod(executable, 0o755);
    for (const mode of ["summary", "cpu"]) {
      for (
        const [damage, exit, expected] of [["yes", "0", 4], ["no", "0", 0], [
          "yes",
          "7",
          7,
        ]] as const
      ) {
        const out = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            new URL("../src/cli.ts", import.meta.url).pathname,
            "render",
            "--perf-mode",
            mode,
            "--perf-output",
            join(root, "results"),
          ],
          cwd: root,
          env: { FIX_DAMAGE: damage, FIX_EXIT: exit, QUARTO: executable },
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert.equal(out.code, expected, new TextDecoder().decode(out.stderr));
      }
      const signaled = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          new URL("../src/cli.ts", import.meta.url).pathname,
          "render",
          "--perf-mode",
          mode,
          "--perf-output",
          join(root, "results"),
        ],
        cwd: root,
        env: { QUARTO: executable, FIX_DAMAGE: "yes", FIX_SIGNAL: "yes" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(signaled.signal, "SIGTERM", new TextDecoder().decode(signaled.stderr));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("W-F2 output directories reject overlap before mutation for explicit and configured paths", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const nativeArgv of [["--output-dir", "site"], ["--output-dir=site"], []]) {
      for (const outputParent of ["site/perf", "site", "."]) {
        await assert.rejects(
          () =>
            prepareRunStorage(
              { cwd: root, quarto: "quarto", nativeArgv, mode: "off", outputParent },
              {
                projectRoot: root,
                kind: "project",
                outputDirectory: join(root, nativeArgv.length ? "configured-other" : "site"),
              },
            ),
          /output-dir/,
        );
      }
    }
    await assert.rejects(() => Deno.stat(join(root, "site")), Deno.errors.NotFound);
    const paths = await prepareRunStorage({
      cwd: root,
      quarto: "quarto",
      nativeArgv: [],
      mode: "off",
    }, { projectRoot: root, kind: "project", outputDirectory: join(root, "site") });
    await Deno.remove(paths.stagingDirectory, { recursive: true });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("W-F3 historical metadata and reports are read-only before any report mutation", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "runs/r"), { recursive: true });
    const original = JSON.stringify({
      runId: "r",
      argv: ["quarto", "render"],
      mode: "summary",
      buildExitCode: 0,
    });
    await Deno.writeTextFile(join(root, "runs/r/run.json"), original);
    await Deno.writeTextFile(join(root, "report.md"), "historical report");
    await assert.rejects(
      () =>
        writeExperimentReport(manifest, [{
          runId: "r",
          events: [],
          executors: {},
          dataValid: true,
          quality,
        }], root),
      /read-only/,
    );
    assert.equal(await Deno.readTextFile(join(root, "runs/r/run.json")), original);
    assert.equal(await Deno.readTextFile(join(root, "report.md")), "historical report");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("W-F4 new off experiment runs immediately write v2 records summaries reports and versioned aggregate", async () => {
  const root = await Deno.makeTempDir();
  try {
    const prepared: PreparedVariant = { root, variant: "candidate", manifest };
    const scenario: Scenario = {
      id: "fixture",
      cwd: ".",
      executable: "/usr/bin/true",
      args: [],
      cachePolicy: "repeat-render",
      mode: "off",
      scope: { modules: [], extensions: [], strict: true },
      resources: { wall: true, cpu: false, peakRss: false },
    };
    const result = await executeScenario(scenario, prepared, "off", {
      outputRoot: join(root, "runs"),
    });
    validateRunRecord(
      JSON.parse(await Deno.readTextFile(join(result.outputDirectory, "run.json"))),
    );
    validateRunSummary(
      JSON.parse(await Deno.readTextFile(join(result.outputDirectory, "summary.json"))),
    );
    await Deno.stat(join(result.outputDirectory, "report.md"));
    await Deno.writeTextFile(
      join(root, "candidate.manifest.json"),
      JSON.stringify({
        ...manifest,
        sources: [{
          repository: "org/Fixture",
          sourceKind: "local-candidate",
          sha: "a".repeat(40),
          baseSha: "b".repeat(40),
          checkoutPath: root,
          remoteRef: "main",
          fetchedAt: "2026-10-24T00:00:00Z",
        }],
      }),
    );
    for (const command of ["report", "verify"]) {
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          new URL("../src/cli.ts", import.meta.url).pathname,
          "experiment",
          command,
          "--workspace",
          root,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(out.code, 0, new TextDecoder().decode(out.stderr));
    }
    const aggregate = JSON.parse(await Deno.readTextFile(join(root, "summary.json")));
    assert.equal(aggregate.schema_version, 2);
    assert.equal(aggregate.runs.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("W-F5 foreign experiment raw events remain but never enter validated intervals or trace", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "events/p"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "mode.json"),
      JSON.stringify({ runId: "r", experimentId: "e", mode: "trace" }),
    );
    await Deno.writeTextFile(
      join(root, "events/p/ts.summary.json"),
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
        counters: {},
      }),
    );
    const events = [1, 2, 3, 4].map((sequence) => ({
      schema_version: 1,
      experiment_id: sequence < 3 ? "e" : "foreign",
      run_id: "r",
      process_id: "p",
      executor_id: "ts",
      sequence,
      event: sequence % 2 ? "begin" : "end",
      kind: "phase",
      span_id: sequence < 3 ? "valid" : "foreign",
      operation_id: sequence < 3 ? "valid" : "foreign",
      origin: "manual",
      clock_domain: "monotonic_process",
      timestamp_us: sequence * 100,
      status: sequence % 2 ? undefined : "ok",
    }));
    await Deno.writeTextFile(
      join(root, "events/p/ts.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const normalized = await normalizeRun(root);
    assert.equal(normalized.dataValid, false);
    assert.equal(normalized.events.length, 4);
    assert.deepEqual(validatedIntervals(normalized).map((x) => x.begin.operation_id), ["valid"]);
    assert.deepEqual(operationTotals(normalized).map((x) => x.operation), ["valid"]);
    assert.deepEqual(traces(normalized).wall.traceEvents.map((x) => x.name), ["valid"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("W-F3 CLI report and verify refuse historical workspaces without changing aggregate bytes", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "runs/r"), { recursive: true });
    const originals = {
      "candidate.manifest.json": JSON.stringify({
        experimentId: "e",
        sources: [],
        packages: [],
        runtime: {},
      }),
      "runs/r/run.json": JSON.stringify({ runId: "r", mode: "off", buildExitCode: 0 }),
      "summary.json": '["historical"]\n',
      "report.md": "old report\n",
    };
    for (const [path, bytes] of Object.entries(originals)) {
      await Deno.writeTextFile(join(root, path), bytes);
    }
    for (const command of ["report", "verify"]) {
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          new URL("../src/cli.ts", import.meta.url).pathname,
          "experiment",
          command,
          "--workspace",
          root,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(out.code, 2);
      assert.match(new TextDecoder().decode(out.stderr), /read-only/);
      for (const [path, bytes] of Object.entries(originals)) {
        assert.equal(await Deno.readTextFile(join(root, path)), bytes);
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("W-F2 inspect keeps configured publication paths, argv override, separator and symlink overlap", async () => {
  const { resolveRenderProject } = await import("../src/adapters/quarto/inspect.ts");
  const root = await Deno.makeTempDir();
  try {
    const executable = join(root, "quarto");
    await Deno.writeTextFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' '{"dir":"${root}","files":{"config":["_quarto.yml"]},"config":{"project":{"output-dir":"configured"}}}'\n`,
    );
    await Deno.chmod(executable, 0o755);
    for (
      const [nativeArgv, expected] of [
        [[], "configured"],
        [["--output-dir", "explicit"], "explicit"],
        [["--output-dir=explicit"], "explicit"],
        [["--", "--output-dir=literal"], "configured"],
      ] as [string[], string][]
    ) {
      const target = await resolveRenderProject({
        cwd: root,
        quarto: executable,
        nativeArgv,
        mode: "off",
      });
      assert.equal(target.outputDirectory, join(root, expected));
    }
    await Deno.mkdir(join(root, "site"));
    await Deno.symlink(join(root, "site"), join(root, "alias"));
    await assert.rejects(
      () =>
        prepareRunStorage({
          cwd: root,
          quarto: executable,
          nativeArgv: [],
          mode: "off",
          outputParent: "alias/perf",
        }, { projectRoot: root, kind: "project", outputDirectory: join(root, "site") }),
      /output-dir/,
    );
    await assert.rejects(() => Deno.stat(join(root, "site/perf")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("W-F4 diagnostic success and failure immediately use shared v2 artifacts", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const code of [0, 7]) {
      const script = join(root, `native${code}.ts`);
      await Deno.writeTextFile(script, `Deno.exit(${code});`);
      const result = await executeScenario(
        {
          id: "diagnostic",
          cwd: ".",
          executable: Deno.execPath(),
          args: ["run", "--no-config", "--no-lock", script],
          cachePolicy: "repeat-render",
          mode: "summary",
          scope: { modules: [], extensions: [], strict: true },
          resources: { wall: true, cpu: false, peakRss: false },
        },
        { root, variant: "candidate", manifest },
        "summary",
        { outputRoot: join(root, "runs") },
      );
      const record = validateRunRecord(
        JSON.parse(await Deno.readTextFile(join(result.outputDirectory, "run.json"))),
      );
      assert.equal(record.outcome.code, code);
      assert.equal(record.request.mode, "summary");
      validateRunSummary(
        JSON.parse(await Deno.readTextFile(join(result.outputDirectory, "summary.json"))),
      );
      await Deno.stat(join(result.outputDirectory, "report.md"));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("W-F3 historical manifest or aggregate is refused even without old per-run metadata", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(root, "report.md"), "historical");
    await assert.rejects(
      () =>
        writeExperimentReport(
          { experimentId: "e", sources: [], packages: [], runtime: {} },
          [],
          root,
        ),
      /read-only/,
    );
    assert.equal(await Deno.readTextFile(join(root, "report.md")), "historical");
    await Deno.writeTextFile(join(root, "summary.json"), "[]\n");
    await assert.rejects(() => writeExperimentReport(manifest, [], root), /read-only/);
    assert.equal(await Deno.readTextFile(join(root, "summary.json")), "[]\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
