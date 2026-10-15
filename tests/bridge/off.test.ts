import { strict as assert } from "node:assert";
import { createMetrics } from "../../bridge/bridge.ts";

Deno.test("off identity: functions, Promise, env; no registry or clock access", () => {
  Deno.env.set("COURSE_PERF_MODE", "off");
  const symbol = Symbol.for("course.performance.agent.v1");
  Object.defineProperty(globalThis, symbol, {
    configurable: true,
    get() {
      throw new Error("registry accessed");
    },
  });
  try {
    const metrics = createMetrics("test");
    const sync = function (this: unknown) {
      return this;
    };
    const promise = Promise.resolve(4), asyncFn = () => promise, env = { TEST: "value" };
    assert.equal(metrics.wrapSync({ id: "sync", kind: "phase" }, sync), sync);
    assert.equal(metrics.wrapAsync({ id: "async", kind: "phase" }, asyncFn)(), promise);
    assert.equal(metrics.wrapWalk({ id: "walk", kind: "ast_walk", scope: "fragment" }, sync), sync);
    assert.equal(metrics.childEnv(env), env);
  } finally {
    Reflect.deleteProperty(globalThis, symbol);
    Deno.env.delete("COURSE_PERF_MODE");
  }
});

Deno.test("requested diagnostics with missing or wrong ABI preserves build and records invalidity", () => {
  Deno.env.set("COURSE_PERF_MODE", "summary");
  const registry = Symbol.for("course.performance.agent.v1"),
    failures = Symbol.for("course.performance.failures.v1");
  const global = globalThis as Record<symbol, unknown>;
  global[registry] = { abiVersion: 2 };
  global[failures] = [];
  try {
    const fn = () => 42;
    assert.equal(createMetrics("test").wrapSync({ id: "phase", kind: "phase" }, fn)(), 42);
    assert.equal((global[failures] as string[]).length, 1);
  } finally {
    delete global[registry];
    delete global[failures];
    Deno.env.delete("COURSE_PERF_MODE");
  }
});

Deno.test("ordinary facade import needs no permission to read environment", async () => {
  const root = await Deno.makeTempDir();
  try {
    const entry = root + "/entry.ts";
    await Deno.writeTextFile(
      entry,
      `import {createMetrics} from ${
        JSON.stringify(new URL("../../bridge/bridge.ts", import.meta.url).href)
      };const fn=()=>42;const m=createMetrics('test');if(m.wrapSync({id:'x',kind:'phase'},fn)!==fn)throw new Error('identity');console.log(fn());`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--no-lock", entry],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    assert.equal(new TextDecoder().decode(out.stdout), "42\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
