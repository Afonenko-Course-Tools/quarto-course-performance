import { strict as assert } from "node:assert";
import { cleanEnvironment, executeScenario } from "../../src/runner/execute.ts";
import type { PreparedVariant, RunResult, Scenario } from "../../src/config/types.ts";
import { join } from "node:path";
import { validateRunRecord, validateRunSummary } from "../../src/report/types.ts";
import { writeRunArtifacts } from "../../src/report/run.ts";
Deno.test("off clears inherited diagnostics but retains functional course profile", () => {
  const env = cleanEnvironment({
    COURSE_PERF_MODE: "trace",
    COURSE_BUILD_TRACE: "file",
    QUARTO_PROFILER_OUTPUT: "file",
    QUARTO_DENO: "launcher",
    QUARTO_PANDOC: "launcher",
    QUARTO_TS_PROFILE: "true",
    QUARTO_PROFILE: "student",
    FUNCTIONAL: "keep",
  });
  assert.deepEqual(env, { QUARTO_PROFILE: "student", FUNCTIONAL: "keep" });
});
Deno.test("runner keeps argv, cwd, outputs and build exit code and off creates no telemetry", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf runner " });
  const release = join(root, "release");
  let running: Promise<RunResult> | undefined;
  try {
    const path = join(root, "fake.ts");
    await Deno.writeTextFile(
      path,
      `const encoder = new TextEncoder();
const header = encoder.encode(JSON.stringify([Deno.args,Deno.cwd(),Deno.env.get('QUARTO_PROFILE'),Deno.env.get('COURSE_PERF_MODE')]) + '\\n');
const error = encoder.encode('error-stream\\n');
const out = new Uint8Array(header.length + 262144), err = new Uint8Array(error.length + 262144);
out.set(header); err.set(error);
for (let i = 0; i < 262144; i++) { out[header.length + i] = i % 256; err[error.length + i] = 255 - i % 256; }
async function write(file, bytes) { let offset = 0; while (offset < bytes.length) offset += await file.write(bytes.subarray(offset)); }
await Promise.all([write(Deno.stdout, out), write(Deno.stderr, err)]);
const deadline = Date.now() + 2000;
while (Date.now() < deadline) {
  try { await Deno.stat('release'); Deno.exit(23); }
  catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
  await new Promise(r => setTimeout(r, 10));
}
throw new Error('Контрольный child не был освобождён');`,
    );
    const scenario: Scenario = {
      id: "fake",
      cwd: ".",
      executable: Deno.execPath(),
      args: ["run", "-A", path, "arg with spaces"],
      cachePolicy: "repeat-render",
      mode: "off",
      scope: { modules: [], extensions: [], strict: true },
      resources: { wall: true, cpu: true, peakRss: true },
    };
    const prepared: PreparedVariant = {
      variant: "candidate",
      root,
      manifest: {
        schema_version: 2 as const,
        projectSource: "org/Fixture",
        replacements: [],
        experimentId: "e",
        sources: [],
        packages: [],
        runtime: {},
      },
    };
    running = executeScenario(scenario, prepared, "off", {
      outputRoot: join(root, "runs"),
      env: { QUARTO_PROFILE: "student", COURSE_PERF_MODE: "trace" },
    });
    let finished = false;
    void running.then(() => {
      finished = true;
    }, () => {
      finished = true;
    });
    const expectedHeader = new TextEncoder().encode(
      JSON.stringify([["arg with spaces"], root, "student", null]) + "\n",
    );
    const expectedError = new TextEncoder().encode("error-stream\n");
    const expectedOut = new Uint8Array(expectedHeader.length + 262144);
    const expectedErr = new Uint8Array(expectedError.length + 262144);
    expectedOut.set(expectedHeader);
    expectedErr.set(expectedError);
    for (let i = 0; i < 262144; i++) {
      expectedOut[expectedHeader.length + i] = i % 256;
      expectedErr[expectedError.length + i] = 255 - i % 256;
    }
    let directory: string | undefined, early = false;
    const deadline = performance.now() + 1200;
    while (performance.now() < deadline) {
      try {
        if (!directory) {
          for await (const entry of Deno.readDir(join(root, "runs"))) {
            if (entry.isDirectory) directory = join(root, "runs", entry.name);
          }
        }
        if (directory) {
          early = (await Deno.stat(join(directory, "stdout.log"))).size === expectedOut.length &&
            (await Deno.stat(join(directory, "stderr.log"))).size === expectedErr.length;
          if (early) break;
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(early && directory, "Оба лога должны быть доступны до завершения child");
    assert.equal(finished, false, "Child завершился до открытия gate");
    assert.deepEqual(await Deno.readFile(join(directory, "stdout.log")), expectedOut);
    assert.deepEqual(await Deno.readFile(join(directory, "stderr.log")), expectedErr);
    await Deno.writeTextFile(release, "");
    const result = await running;
    assert.equal(result.buildExitCode, 23);
    assert.equal(result.dataValid, true);
    assert.equal(result.preparation.length, 0);
    assert.deepEqual(
      await Deno.readFile(join(result.outputDirectory, "stdout.log")),
      expectedOut,
    );
    assert.deepEqual(
      await Deno.readFile(join(result.outputDirectory, "stderr.log")),
      expectedErr,
    );
    assert(result.wallSeconds > 0);
    await assert.rejects(
      () => Deno.stat(join(result.outputDirectory, "events")),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.writeTextFile(release, "");
    await running?.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Hyperfine 2 records raw resource metrics and literal argv without executing shell substitutions", async () => {
  const root = await Deno.makeTempDir({ prefix: "hyperfine argv " });
  try {
    const path = join(root, "fake.ts");
    await Deno.writeTextFile(
      path,
      "await Deno.writeTextFile('args.json',JSON.stringify(Deno.args));Deno.exit(23);",
    );
    const literal = "space ' quote $(touch forbidden) `no-command`",
      s: Scenario = {
        id: "fake",
        cwd: ".",
        executable: Deno.execPath(),
        args: ["run", "-A", path, literal],
        cachePolicy: "repeat-render",
        mode: "off",
        scope: { modules: [], extensions: [], strict: true },
        resources: { wall: true, cpu: true, peakRss: true },
      },
      p: PreparedVariant = {
        variant: "candidate",
        root,
        manifest: {
          schema_version: 2 as const,
          projectSource: "org/Fixture",
          replacements: [],
          experimentId: "e",
          sources: [],
          packages: [],
          runtime: {},
        },
      };
    const result = await executeScenario(s, p, "off", {
      outputRoot: join(root, "runs"),
      useHyperfine: true,
    });
    assert.equal(result.buildExitCode, 23);
    assert.deepEqual(JSON.parse(await Deno.readTextFile(join(root, "args.json"))), [literal]);
    await assert.rejects(() => Deno.stat(join(root, "forbidden")), Deno.errors.NotFound);
    const raw = JSON.parse(await Deno.readTextFile(join(result.outputDirectory, "hyperfine.json")));
    assert.equal(raw.schema_version, 2);
    assert.equal(raw.results[0].measurements[0].exit_code, 23);
    assert(result.wallSeconds > 0);
    assert(raw.results[0].measurements[0].time_cpu.value >= 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("off clears an inherited diagnostic Quarto share override", () => {
  assert.deepEqual(
    cleanEnvironment({ QUARTO_SHARE_PATH: "old-diagnostic-share", FUNCTIONAL: "keep" }),
    { FUNCTIONAL: "keep" },
  );
});

Deno.test("resource measurement retains the tool signal separately from a numeric exit", async () => {
  const root = await Deno.makeTempDir();
  try {
    const script = join(root, "signal.ts");
    await Deno.writeTextFile(script, "Deno.kill(Deno.pid, 'SIGTERM');await new Promise(()=>{});");
    const scenario: Scenario = {
      id: "signal",
      cwd: ".",
      executable: Deno.execPath(),
      args: ["run", "-A", script],
      cachePolicy: "repeat-render",
      mode: "off",
      scope: { modules: [], extensions: [], strict: true },
      resources: { wall: true, cpu: true, peakRss: true },
    };
    const prepared: PreparedVariant = {
      variant: "candidate",
      root,
      manifest: {
        schema_version: 2 as const,
        projectSource: "org/Fixture",
        replacements: [],
        experimentId: "e",
        sources: [],
        packages: [],
        runtime: {},
      },
    };
    const result = await executeScenario(scenario, prepared, "off", {
      outputRoot: join(root, "runs"),
    });
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.buildExitCode, 143);
    await Deno.writeTextFile(script, "Deno.exit(143);");
    const numeric = await executeScenario(scenario, prepared, "off", {
      outputRoot: join(root, "runs"),
    });
    assert.equal(numeric.signal, null);
    assert.equal(numeric.buildExitCode, 143);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("external TERM caller preserves partial reports when native status is unavailable", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf caller term " });
  try {
    for (const missingStatus of [false, true]) {
      const directory = join(root, String(missingStatus));
      await Deno.mkdir(directory);
      const fake = join(directory, "child.ts"), callerPath = join(directory, "caller.ts");
      await Deno.writeTextFile(
        fake,
        `
Deno.addSignalListener('SIGTERM', () => Deno.exit(143));
await Deno.stdout.write(new TextEncoder().encode('saved-out\\n'));
await Deno.stderr.write(new TextEncoder().encode('saved-err\\n'));
if (${missingStatus}) {
  for await (const run of Deno.readDir('runs')) {
    if (run.isDirectory) await Deno.mkdir('runs/' + run.name + '/tool-status.json');
  }
}
await Deno.writeTextFile('ready', String(Deno.pid));
setInterval(() => {}, 1000);
`,
      );
      await Deno.writeTextFile(
        callerPath,
        `
import { executeScenario } from ${
          JSON.stringify(new URL("../../src/runner/execute.ts", import.meta.url).href)
        };
const root = ${JSON.stringify(directory)};
try {
  await executeScenario({id:'term',cwd:'.',executable:Deno.execPath(),args:['run','-A',${
          JSON.stringify(fake)
        }],
    cachePolicy:'repeat-render',mode:'off',scope:{modules:[],extensions:[],strict:true},
    resources:{wall:true,cpu:${missingStatus},peakRss:${missingStatus}}},
    {variant:'candidate',root,manifest:{schema_version:2,projectSource:'org/Fixture',replacements:[],
      experimentId:'e',sources:[],packages:[],runtime:{}}},'off',{outputRoot:root+'/runs'});
  Deno.exit(0);
} catch { Deno.exit(7); }
`,
      );
      const caller = new Deno.Command(Deno.execPath(), {
        args: ["run", "--cached-only", "--no-check", "-A", callerPath],
        cwd: directory,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const output = caller.output();
      let outputClosed = false;
      void output.then(() => {
        outputClosed = true;
      }, () => {
        outputClosed = true;
      });
      let childPid: number | undefined;
      try {
        const deadline = performance.now() + 1500;
        while (performance.now() < deadline) {
          try {
            childPid = Number(await Deno.readTextFile(join(directory, "ready")));
            if (Number.isInteger(childPid) && childPid > 0) break;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert(
          childPid && Number.isInteger(childPid),
          "Fake child must reach its output boundary before caller TERM",
        );
        caller.kill("SIGTERM");
        // Модель outer group TERM: caller и известный test-owned native получают сигнал.
        try {
          Deno.kill(childPid, "SIGTERM");
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            caller.status,
            new Promise((_, reject) => {
              waitTimer = setTimeout(
                () =>
                  reject(
                    new Error(`Caller TERM did not finalize (missingStatus=${missingStatus})`),
                  ),
                1000,
              );
            }),
          ]);
        } finally {
          if (waitTimer !== undefined) clearTimeout(waitTimer);
        }
        const stopped = await output;
        await Deno.writeFile(join(directory, "caller.stdout.log"), stopped.stdout);
        await Deno.writeFile(join(directory, "caller.stderr.log"), stopped.stderr);
        await Deno.writeTextFile(
          join(directory, "caller-status.json"),
          JSON.stringify({ missingStatus, code: stopped.code, signal: stopped.signal }),
        );
        assert.notEqual(
          stopped.code,
          0,
          `Interrupted call must not return a completed RunResult (missingStatus=${missingStatus}): ${
            new TextDecoder().decode(stopped.stderr)
          }`,
        );
        const runs = [];
        for await (const run of Deno.readDir(join(directory, "runs"))) {
          if (run.isDirectory) runs.push(run.name);
        }
        assert.equal(runs.length, 1);
        const run = join(directory, "runs", runs[0]);
        let metadata: string | undefined;
        try {
          metadata = await Deno.readTextFile(join(run, "run.json"));
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        assert(metadata, "TERM caller must preserve a partial run.json before rejecting");
        const record = validateRunRecord(JSON.parse(metadata));
        assert.equal(record.dataValid, false);
        assert.equal(record.quality.coverageComplete, false);
        assert("completion" in record.outcome);
        assert.equal(record.outcome.completion, "incomplete");
        assert.equal(record.outcome.interruptionSignal, "SIGTERM");
        assert.equal(record.outcome.code, missingStatus ? null : 143);
        assert.equal(
          record.outcome.signal,
          null,
          "Requested TERM must not replace a numeric native exit's signal",
        );
        assert.equal(record.outcome.wallSeconds === null, missingStatus);
        assert.equal(await Deno.readTextFile(join(run, "stdout.log")), "saved-out\n");
        assert((await Deno.readTextFile(join(run, "stderr.log"))).startsWith("saved-err\n"));
        const summary = validateRunSummary(
          JSON.parse(await Deno.readTextFile(join(run, "summary.json"))),
        );
        assert.equal(summary.dataValid, false);
        assert(summary.quality.errors.length > 0);
        const report = await Deno.readTextFile(join(run, "report.md"));
        assert(report.includes("INVALID"));
        if (missingStatus) assert(report.includes("неизвестно"));
        assert.throws(() => validateRunRecord({ ...record, dataValid: true }), /incomplete/);
        if (missingStatus) {
          assert.throws(
            () =>
              validateRunRecord({ ...record, outcome: { ...record.outcome, signal: "SIGTERM" } }),
            /unknown/,
          );
        }
        await writeRunArtifacts(run, {
          ...record,
          dataValid: true,
          quality: { ...record.quality, coverageComplete: true },
        });
        const refreshed = validateRunRecord(
          JSON.parse(await Deno.readTextFile(join(run, "run.json"))),
        );
        assert.equal(refreshed.dataValid, false);
        assert.equal(refreshed.quality.coverageComplete, false);
      } finally {
        if (!outputClosed) {
          try {
            caller.kill("SIGKILL");
          } catch { /* Test-owned caller already exited. */ }
          if (childPid) {
            try {
              Deno.kill(childPid, "SIGKILL");
            } catch { /* Test-owned child already exited. */ }
          }
        }
        const stopped = await output;
        await Deno.writeFile(join(directory, "caller.stdout.log"), stopped.stdout);
        await Deno.writeFile(join(directory, "caller.stderr.log"), stopped.stderr);
        await Deno.writeTextFile(
          join(directory, "caller-status.json"),
          JSON.stringify({ missingStatus, code: stopped.code, signal: stopped.signal }),
        );
      }
    }
  } finally {
    const evidence = Deno.env.get("PERFORMANCE_TERM_TEST_EVIDENCE");
    if (evidence) await Deno.rename(root, evidence);
    else await Deno.remove(root, { recursive: true });
  }
});
