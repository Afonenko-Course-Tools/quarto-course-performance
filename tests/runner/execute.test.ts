import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { PreparedVariant, Scenario } from "../../src/config/types.ts";
import { array, number, object, parseJson, parseObject } from "../../src/json.ts";
import { cleanEnvironment, executeScenario } from "../../src/runner/execute.ts";
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
  try {
    const path = join(root, "fake.ts");
    await Deno.writeTextFile(
      path,
      "console.log(JSON.stringify([Deno.args,Deno.cwd(),Deno.env.get('QUARTO_PROFILE'),Deno.env.get('COURSE_PERF_MODE')]));console.error('error-stream');Deno.exit(23);",
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
    const result = await executeScenario(scenario, prepared, "off", {
      outputRoot: join(root, "runs"),
      env: { QUARTO_PROFILE: "student", COURSE_PERF_MODE: "trace" },
    });
    assert.equal(result.buildExitCode, 23);
    assert.equal(result.dataValid, true);
    assert.equal(result.preparedScripts.length, 0);
    assert.deepEqual(
      parseJson(await Deno.readTextFile(join(result.outputDirectory, "stdout.log"))),
      [["arg with spaces"], root, "student", null],
    );
    assert.equal(
      await Deno.readTextFile(join(result.outputDirectory, "stderr.log")),
      "error-stream\n",
    );
    assert(result.wallSeconds > 0);
    const metadata = parseObject(await Deno.readTextFile(join(result.outputDirectory, "run.json")));
    assert.equal(object(metadata.versions).tool, "2.1.0");
    await assert.rejects(
      () => Deno.stat(join(result.outputDirectory, "events")),
      Deno.errors.NotFound,
    );
  } finally {
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
    assert.deepEqual(parseJson(await Deno.readTextFile(join(root, "args.json"))), [literal]);
    await assert.rejects(() => Deno.stat(join(root, "forbidden")), Deno.errors.NotFound);
    const raw = parseObject(
      await Deno.readTextFile(join(result.outputDirectory, "hyperfine.json")),
    );
    assert.equal(raw.schema_version, 2);
    const measurement = object(array(object(array(raw.results)[0]).measurements)[0]);
    assert.equal(measurement.exit_code, 23);
    assert(result.wallSeconds > 0);

    assert(number(object(measurement.time_cpu).value) >= 0);
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

Deno.test("scenario cancellation uses the accepted owned process and retains native termination", async () => {
  const root = await Deno.makeTempDir({ prefix: "scenario abort " });
  const controller = new AbortController();
  try {
    const entry = join(root, "entry.ts"), ready = join(root, "native-ready");
    await Deno.writeTextFile(
      entry,
      `await Deno.writeTextFile(${
        JSON.stringify(ready)
      },String(Deno.pid));setInterval(()=>{},1000);await new Promise(()=>{});`,
    );
    const scenario: Scenario = {
      id: "abort",
      cwd: ".",
      executable: Deno.execPath(),
      args: ["run", "-A", entry],
      cachePolicy: "repeat-render",
      mode: "off",
      scope: { modules: [], extensions: [], strict: true },
      resources: { wall: true, cpu: true, peakRss: true },
    };
    const prepared: PreparedVariant = {
      variant: "candidate",
      root,
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
    const running = executeScenario(scenario, prepared, "off", {
      outputRoot: join(root, "runs"),
      abortSignal: controller.signal,
    });
    const deadline = performance.now() + 5000;
    while (true) {
      try {
        await Deno.stat(ready);
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        if (performance.now() > deadline) throw new Error("Native did not start");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    controller.abort("SIGTERM");
    const result = await running;
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.buildExitCode, 143);
    const record = parseObject(await Deno.readTextFile(join(result.outputDirectory, "run.json")));
    assert.equal(object(record.outcome).signal, "SIGTERM");
    assert.equal(object(record.outcome).code, 143);
  } finally {
    controller.abort("SIGTERM");
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("scenario bootstrap failure never publishes a fabricated native outcome", async () => {
  const root = await Deno.makeTempDir();
  try {
    const scenario: Scenario = {
      id: "missing",
      cwd: ".",
      executable: join(root, "missing-native"),
      args: [],
      cachePolicy: "repeat-render",
      mode: "off",
      scope: { modules: [], extensions: [], strict: true },
      resources: { wall: true, cpu: false, peakRss: false },
    };
    const prepared: PreparedVariant = {
      variant: "candidate",
      root,
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
    await assert.rejects(() =>
      executeScenario(scenario, prepared, "off", { outputRoot: join(root, "runs") })
    );
    for await (const run of Deno.readDir(join(root, "runs"))) {
      await assert.rejects(
        () => Deno.stat(join(root, "runs", run.name, "run.json")),
        Deno.errors.NotFound,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("failed Hyperfine envelope cannot promote an exported zero to native success", async () => {
  const root = await Deno.makeTempDir({ prefix: "hyperfine envelope " });
  try {
    const bin = join(root, "bin");
    await Deno.mkdir(bin);
    await Deno.writeTextFile(
      join(bin, "hyperfine"),
      `#!/usr/bin/python3
import json,sys
p=sys.argv[sys.argv.index('--export-json')+1]
with open(p,'w') as f: json.dump({'schema_version':2,'results':[{'measurements':[{'time_wall_clock':{'unit':'second','value':0.1},'exit_code':0}]}]},f)
print('failed after export',file=sys.stderr)
sys.exit(7)
`,
    );
    await Deno.chmod(join(bin, "hyperfine"), 0o755);
    const scenario: Scenario = {
      id: "hyperfine-failure",
      cwd: ".",
      executable: "/usr/bin/true",
      args: [],
      cachePolicy: "repeat-render",
      mode: "off",
      scope: { modules: [], extensions: [], strict: true },
      resources: { wall: true, cpu: true, peakRss: true },
    };
    const prepared: PreparedVariant = {
      variant: "candidate",
      root,
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
    await assert.rejects(
      () =>
        executeScenario(scenario, prepared, "off", {
          outputRoot: join(root, "runs"),
          useHyperfine: true,
          env: { PATH: bin + ":" + Deno.env.get("PATH") },
        }),
      /Hyperfine не завершил измерение: code=7/,
    );
    for await (const run of Deno.readDir(join(root, "runs"))) {
      const output = join(root, "runs", run.name);
      await Deno.stat(join(output, "hyperfine.json"));
      assert.match(await Deno.readTextFile(join(output, "stderr.log")), /failed after export/);
      await assert.rejects(() => Deno.stat(join(output, "run.json")), Deno.errors.NotFound);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
