import { strict as assert } from "node:assert";
import { join } from "node:path";
import { validateTelemetryEnvironment } from "../../src/runner/environment.ts";
import { probeQuarto } from "../../src/adapters/quarto/capabilities.ts";

Deno.test("telemetry conflicts are separate from functional overrides and never mutate environment", () => {
  const validate = validateTelemetryEnvironment;
  const functional = {
    QUARTO_DENO: "custom-deno",
    QUARTO_PANDOC: "custom-pandoc",
    QUARTO_SHARE_PATH: "custom-share",
    QUARTO_DENO_EXTRA_OPTIONS: "--no-config",
    QUARTO_DENO_V8_OPTIONS: "--max-old-space-size=4096",
    XDG_CACHE_HOME: "/tmp/cache",
    HTTPS_PROXY: "http://proxy",
    DENO_DIR: "/tmp/deno",
    QUARTO_PROFILE: "student",
  };
  const before = JSON.stringify(functional);
  assert.deepEqual(validate(functional), []);
  assert.equal(JSON.stringify(functional), before);
  const conflicting = {
    ...functional,
    COURSE_PERF_MODE: "trace",
    COURSE_BUILD_TRACE: "file",
    QUARTO_TS_PROFILE: "true",
    QUARTO_PROFILER_OUTPUT: "file",
  };
  const snapshot = JSON.stringify(conflicting);
  assert.deepEqual(validate(conflicting).sort(), [
    "COURSE_BUILD_TRACE",
    "COURSE_PERF_MODE",
    "QUARTO_PROFILER_OUTPUT",
    "QUARTO_TS_PROFILE",
  ]);
  assert.equal(JSON.stringify(conflicting), snapshot);
});

Deno.test("probe preserves effective runtime, Deno options, cache and network environment", async () => {
  const root = await Deno.makeTempDir({ prefix: "effective runtime " });
  const old = Deno.env.get("QUARTO_SHARE_PATH");
  const inherited = Deno.env.get("PERF_TEST_FUNCTIONAL");
  Deno.env.set("PERF_TEST_FUNCTIONAL", "inherited");
  try {
    const deno = join(root, "deno"), pandoc = join(root, "pandoc"), log = join(root, "env.jsonl");
    const script = `#!/usr/bin/env -S ${Deno.execPath()} run -A\nawait Deno.writeTextFile(${
      JSON.stringify(log)
    },JSON.stringify({args:Deno.args,env:Deno.env.toObject()})+'\\n',{append:true});console.log(Deno.args.includes('run')?'--cpu-prof-dir --preload':'Lua 5.4 custom-runtime');\n`;
    for (const path of [deno, pandoc]) {
      await Deno.writeTextFile(path, script);
      await Deno.chmod(path, 0o755);
    }
    // Public --paths permits an effective share without private filter sources.
    Deno.env.set("QUARTO_SHARE_PATH", root);
    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      QUARTO_DENO: deno,
      QUARTO_PANDOC: pandoc,
      QUARTO_SHARE_PATH: root,
      QUARTO_DENO_EXTRA_OPTIONS: "--no-config",
      QUARTO_DENO_V8_OPTIONS: "--max-old-space-size=4096",
      XDG_CACHE_HOME: root,
      HTTPS_PROXY: "http://127.0.0.1:9",
      DENO_DIR: root,
    };
    delete env.PERF_TEST_FUNCTIONAL;
    const before = JSON.stringify(env);
    const caps = await probeQuarto("quarto", env);
    assert.equal(caps.share, root);
    assert.equal(caps.deno, deno);
    assert.equal(caps.pandoc, pandoc);
    assert.equal(caps.filterAdapter, false);
    assert.equal(caps.runtime.quartoFilters, undefined);
    assert.equal(caps.denoPreload, true);
    assert.equal(JSON.stringify(env), before);
    const calls = (await Deno.readTextFile(log)).trim().split("\n").map((line) => JSON.parse(line));
    assert(calls.length >= 3);
    for (const call of calls) assert.equal(call.env.PERF_TEST_FUNCTIONAL, "inherited");
    for (const call of calls) {
      for (
        const key of [
          "QUARTO_DENO",
          "QUARTO_PANDOC",
          "QUARTO_SHARE_PATH",
          "QUARTO_DENO_EXTRA_OPTIONS",
          "QUARTO_DENO_V8_OPTIONS",
          "XDG_CACHE_HOME",
          "HTTPS_PROXY",
          "DENO_DIR",
        ]
      ) assert.equal(call.env[key], env[key]);
    }
  } finally {
    if (inherited === undefined) Deno.env.delete("PERF_TEST_FUNCTIONAL");
    else Deno.env.set("PERF_TEST_FUNCTIONAL", inherited);
    if (old === undefined) Deno.env.delete("QUARTO_SHARE_PATH");
    else Deno.env.set("QUARTO_SHARE_PATH", old);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("system Quarto probe observes bundled runtime capabilities", async () => {
  const caps = await probeQuarto("quarto");
  assert.match(caps.version, /^\d+\.\d+\.\d+/);
  assert.equal(caps.deno, join(caps.bin, "tools", Deno.build.arch, "deno"));
  assert.equal(caps.pandoc, join(caps.bin, "tools", Deno.build.arch, "pandoc"));
  assert.equal(caps.denoPreload, true);
  assert.equal(caps.denoCpu, true);
  assert.equal(caps.luaHook, true);
  assert(caps.runtime.deno.hash);
});
