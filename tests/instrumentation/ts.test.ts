import { number, object } from "../../src/json.ts";
import { strict as assert } from "node:assert";
import { instrumentModule } from "../../src/instrumentation/ts/transform.ts";
import { join } from "node:path";
const bridge = new URL("../../bridge/bridge.ts", import.meta.url).href;
function invoke(exported: unknown, receiver: unknown, args: unknown[]): unknown {
  assert(typeof exported === "function");
  return Reflect.apply(exported, receiver, args);
}
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
    const originalModule: unknown = await import("file://" + join(root, "original.ts")),
      changedModule: unknown = await import("file://" + join(root, "changed.ts"));
    const original = object(originalModule), changed = object(changedModule);
    assert.equal(changed.before, 2);
    assert.equal(
      number(invoke(changed.f, undefined, [4])),
      number(invoke(original.f, undefined, [4])),
    );
    const pending = invoke(changed.a, undefined, []);
    assert(pending instanceof Promise);
    const asyncResult: unknown = await pending;
    assert.equal(asyncResult, 4);
    assert.equal(number(invoke(changed.method, { x: 3 }, [2])), 5);
    assert.equal(number(invoke(changed.closure, undefined, [])), 2);
    assert.throws(() => invoke(changed.bad, undefined, []), (e: unknown) => e === changed.err);
    assert.equal(invoke(changed.main, undefined, []), false);
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
  assert(result.symbols[0]);
  assert.equal(result.symbols[0].manuallyWrapped, true);
  assert(!result.source.includes("return __coursePerf"));
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
