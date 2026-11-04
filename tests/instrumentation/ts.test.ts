import { strict as assert } from "node:assert";
import { instrumentModule } from "../../src/instrumentation/ts/transform.ts";
import { join } from "node:path";
import { installTsAgent } from "../../src/agents/ts/agent.ts";
const bridge = new URL("../../bridge/bridge.ts", import.meta.url).href;
Deno.test("automatic function trace preserves hoisting, recursion, this, args, async and error identity", async () => {
  const root = await Deno.makeTempDir();
  const source = `export const before=f(2); export function f(n:number):number{return n?f(n-1)+1:0;}
export async function a(n=4){return await Promise.resolve(n);}
export function method(this:{x:number},n:number){return this.x+arguments[0];}
export const err={code:42};export function bad(){throw err;}
export const closure=(()=>{let n=1;return ()=>++n;})();
export function main(){return import.meta.main;}`;
  try {
    const out = instrumentModule(source, "fixture.ts", { strict: true, bridgeUrl: bridge });
    await Deno.writeTextFile(join(root, "original.ts"), source);
    await Deno.writeTextFile(join(root, "changed.ts"), out.source);
    const original = await import("file://" + join(root, "original.ts")),
      changed = await import("file://" + join(root, "changed.ts"));
    assert.equal(changed.before, 2);
    assert.equal(changed.f(4), original.f(4));
    assert.equal(await changed.a(), 4);
    assert.equal(changed.method.call({ x: 3 }, 2), 5);
    assert.equal(changed.closure(), 2);
    assert.throws(changed.bad, (e: unknown) => e === changed.err);
    assert.equal(changed.main(), false);
    assert(out.symbols.some((s) => s.start === source.indexOf("export function f")));
    assert.equal(out.skipped.length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("strict scope rejects unsupported generators and constructors and records partial coverage", () => {
  const source = "export function* g(){yield 1;} export class C{constructor(){}}";
  assert.throws(
    () => instrumentModule(source, "unsupported.ts", { strict: true, bridgeUrl: bridge }),
    /coverage|покрыт/i,
  );
  const result = instrumentModule(source, "unsupported.ts", { strict: false, bridgeUrl: bridge });
  assert.equal(result.skipped.length, 2);
  assert.equal(result.symbols.length, 0);
});
Deno.test("manual wrapper registration is excluded from automatic trace", () => {
  const source = "function f(){return 1;} f=metrics.wrapSync({id:'f',kind:'function'},f);";
  const result = instrumentModule(source, "manual.ts", { strict: true, bridgeUrl: bridge });
  assert.equal(result.symbols[0].manuallyWrapped, true);
  assert(!result.source.includes("return __coursePerf"));
  const selected = instrumentModule(source, "manual.ts", {
    strict: true,
    bridgeUrl: bridge,
    topLevelFunctions: ["f"],
  });
  assert.equal(selected.symbols[0].manuallyWrapped, true);
  assert.equal(selected.source, source);
});
Deno.test("module manual binding does not hide a shadowed nested function; unsupported local rebinding is explicit", () => {
  const source =
    "function f(){return 1;} function outer(){function f(){return 7;}return f();} f=metrics.wrapSync({id:'f',kind:'function'},f);";
  const result = instrumentModule(source, "shadow.ts", { strict: true, bridgeUrl: bridge });
  const inner = result.symbols.find((s) =>
    source.slice(s.start, s.end) === "function f(){return 7;}"
  )!;
  assert.equal(inner.manuallyWrapped, false);
  assert.throws(
    () =>
      instrumentModule(
        "function outer(){function f(){return 1;} f=metrics.wrapSync({},f);}",
        "local.ts",
        { strict: true, bridgeUrl: bridge },
      ),
    /coverage/i,
  );
});

Deno.test("top-level function selection keeps recursive execution and observes only requested declarations", async () => {
  const root = await Deno.makeTempDir();
  const key = Symbol.for("course.performance.agent.v1");
  const priorAgent: unknown = Reflect.get(globalThis, key);
  const priorMode = Deno.env.get("COURSE_PERF_MODE");
  const source = `export const failure={code:42};
export function decode(n:number):number {
  function visit(value:number):number {
    if(value<0)throw failure;
    return value===0?0:visit(value-1)+1;
  }
  return visit(n);
}
export function untouched(n:number){return n+10;}
export class C{get value(){return 7;}}`;
  try {
    Deno.env.set("COURSE_PERF_MODE", "summary");
    const agent = installTsAgent({
      experimentId: "e",
      runId: "r",
      processId: "selection",
      outputDirectory: root,
      mode: "summary",
    });
    const names: readonly string[] = ["decode"];
    const selected = instrumentModule(source, "selected.ts", {
      strict: true,
      bridgeUrl: bridge,
      topLevelFunctions: names,
    });
    await Deno.writeTextFile(join(root, "selected.ts"), selected.source);
    const changed = await import("file://" + join(root, "selected.ts"));
    assert.equal(changed.decode(12), 12);
    assert.throws(() => changed.decode(-1), (error: unknown) => error === changed.failure);
    assert.equal(changed.untouched(5), 15);
    assert.equal(new changed.C().value, 7);
    assert.equal(selected.symbols.length, 1);
    assert.equal(selected.symbols[0].start, source.indexOf("export function decode"));
    assert.deepEqual(
      agent.events.filter((event) => event.event === "begin").map((event) => event.operation_id),
      [selected.symbols[0].id, selected.symbols[0].id],
    );
    assert.deepEqual(
      agent.events.filter((event) => event.event === "end").map((event) => event.status),
      ["ok", "error"],
    );
    const plain = instrumentModule(source, "default.ts", { strict: false, bridgeUrl: bridge });
    const visit = plain.symbols.find((symbol) => symbol.start === source.indexOf("function visit"));
    assert(visit);
    await Deno.writeTextFile(join(root, "default.ts"), plain.source);
    const before = agent.events.length;
    const originalScope = await import("file://" + join(root, "default.ts"));
    assert.equal(originalScope.decode(4), 4);
    assert.equal(
      agent.events.slice(before).filter((event) =>
        event.event === "begin" && event.operation_id === visit.id
      ).length,
      5,
    );
  } finally {
    if (priorMode === undefined) Deno.env.delete("COURSE_PERF_MODE");
    else Deno.env.set("COURSE_PERF_MODE", priorMode);
    if (priorAgent === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, priorAgent);
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("top-level function selection refuses missing, ambiguous and unsupported names even in partial mode", () => {
  for (
    const source of [
      "export function other(){return 1;}",
      "function decode(){} function decode(){}",
      "declare function decode():number;",
      "function* decode(){yield 1;}",
      "function decode(){return eval('1');}",
      "function outer(){function decode(){return 1;}}",
    ]
  ) {
    assert.throws(() =>
      instrumentModule(source, "refused.ts", {
        strict: false,
        bridgeUrl: bridge,
        topLevelFunctions: ["decode"],
      }), /coverage/);
  }
  assert.throws(() =>
    instrumentModule("function decode(){return 1;}", "duplicate.ts", {
      strict: false,
      bridgeUrl: bridge,
      topLevelFunctions: ["decode", "decode"],
    }), /coverage/);
});
