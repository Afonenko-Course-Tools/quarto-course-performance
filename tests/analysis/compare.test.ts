import {strict as assert} from "node:assert";
import {compareBenchmarks} from "../../src/analysis/compare.ts";
Deno.test("paired benchmark intervals implement 1% threshold with reproducible resampling",()=>{
  assert.equal(compareBenchmarks(Array(10).fill(1),42).status,"PASS");assert.equal(compareBenchmarks(Array(10).fill(1.02),42).status,"FAIL");
  const values=[.99,1,1,1.01,1.01,1.02,1.02,1.03,1.04,1.04];const result=compareBenchmarks(values,42);assert.equal(result.status,"INCONCLUSIVE");assert.deepEqual(result,compareBenchmarks(values,42));
  assert.throws(()=>compareBenchmarks([],42));assert.throws(()=>compareBenchmarks([0,1],42));
});
