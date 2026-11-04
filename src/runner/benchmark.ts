import { completedNative } from "../report/types.ts";
import type { PreparedVariant, Scenario } from "../config/types.ts";
import { type ExecuteOptions, executeScenario } from "./execute.ts";
export async function benchmarkPair(
  scenario: Scenario,
  left: PreparedVariant,
  right: PreparedVariant,
  options: {
    pairs?: number;
    seed: number;
    executeOptions?: ExecuteOptions;
    onProgress?: (series: unknown) => Promise<void>;
  },
) {
  const count = options.pairs ?? 10;
  if (count < 1 || !Number.isInteger(count)) {
    throw new Error("Число пар должно быть положительным");
  }
  const warmups = [];
  for (const prepared of [left, right]) {
    const warm = await executeScenario(scenario, prepared, "off", options.executeOptions);
    const native = completedNative(warm);
    if (native.code) throw new Error(`Прогрев завершился с кодом ${native.code}`);
    warmups.push(warm.record.runId);
  }
  const pairs = [];
  for (let i = 0; i < count; i++) {
    const order = i % 2 ? "BA" as const : "AB" as const, results = [];
    for (const prepared of order === "AB" ? [left, right] : [right, left]) {
      const result = await executeScenario(scenario, prepared, "off", options.executeOptions);
      if (completedNative(result).code) {
        throw new Error(`Benchmark build failed: ${result.directory}`);
      }
      results.push(result);
    }
    const [a, b] = order === "AB" ? results : results.toReversed();
    pairs.push({
      order,
      controlWall: completedNative(a).wallSeconds,
      candidateWall: completedNative(b).wallSeconds,
      controlRunId: a.record.runId,
      candidateRunId: b.record.runId,
    });
    await options.onProgress?.({ pairs, warmups, seed: options.seed, complete: false });
  }
  return { pairs, warmups, seed: options.seed, complete: true };
}
