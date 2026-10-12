import { strict as assert } from "node:assert";
import { instrumentModule } from "../../src/instrumentation/ts/transform.ts";
import { join } from "node:path";
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
});
