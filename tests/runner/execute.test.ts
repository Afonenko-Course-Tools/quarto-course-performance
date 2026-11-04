import { strict as assert } from "node:assert";
import { cleanEnvironment, executeScenario } from "../../src/runner/execute.ts";
import type { PreparedVariant, RunResult, Scenario } from "../../src/config/types.ts";
import { join } from "node:path";
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
