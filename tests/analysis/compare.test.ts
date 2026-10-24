import { strict as assert } from "node:assert";
import { compareBenchmarks } from "../../src/analysis/compare.ts";
Deno.test("paired benchmark intervals implement 1% threshold with reproducible resampling", () => {
  assert.equal(compareBenchmarks(Array(10).fill(1), 42, 1.01).status, "PASS");
  assert.equal(compareBenchmarks(Array(10).fill(1.02), 42, 1.01).status, "FAIL");
  const values = [.99, 1, 1, 1.01, 1.01, 1.02, 1.02, 1.03, 1.04, 1.04];
  const result = compareBenchmarks(values, 42, 1.01);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.deepEqual(result, compareBenchmarks(values, 42, 1.01));
  assert.throws(() => compareBenchmarks([], 42, 1.01));
  assert.throws(() => compareBenchmarks([0, 1], 42, 1.01));
});

Deno.test("benchmark comparison has no implicit Java threshold", () => {
  assert.throws(() => Reflect.apply(compareBenchmarks, null, [[1], 42]), /policy|ratio|порог/i);
  assert.equal(compareBenchmarks([1.1], 42, 1.2).status, "PASS");
  assert.equal(compareBenchmarks([1.1], 42, 1).status, "FAIL");
});
