import type { PreparedVariant, RunResult, Scenario } from "../config/types.ts";
import { type ExecuteOptions, executeScenario } from "./execute.ts";
export interface BenchmarkProgress {
  pairs: {
    order: "AB" | "BA";
    controlWall: number;
    candidateWall: number;
    controlRunId: string;
    candidateRunId: string;
  }[];
  warmups: string[];
  seed: number;
  complete: boolean;
}
export async function benchmarkPair(
  scenario: Scenario,
  left: PreparedVariant,
  right: PreparedVariant,
  options: {
    pairs?: number;
    seed: number;
    executeOptions?: ExecuteOptions;
    onProgress?: (series: BenchmarkProgress) => Promise<void>;
  },
) {
  const count = options.pairs ?? 10;
  if (count < 1 || !Number.isInteger(count)) {
    throw new Error("Число пар должно быть положительным");
  }
  const warmups: string[] = [];
  for (const prepared of [left, right]) {
    const warm = await executeScenario(scenario, prepared, "off", options.executeOptions);
    if (warm.buildExitCode || !warm.dataValid) {
      throw new Error(
        `Прогрев непригоден: native=${warm.buildExitCode}, dataValid=${warm.dataValid}; ${warm.outputDirectory}`,
      );
    }
    warmups.push(warm.runId);
  }
  const pairs: BenchmarkProgress["pairs"] = [];
  for (let i = 0; i < count; i++) {
    const order = i % 2 ? "BA" as const : "AB" as const, results: RunResult[] = [];
    for (const prepared of order === "AB" ? [left, right] : [right, left]) {
      const result = await executeScenario(scenario, prepared, "off", options.executeOptions);
      if (result.buildExitCode || !result.dataValid) {
        throw new Error(`Benchmark build failed: ${result.outputDirectory}`);
      }
      results.push(result);
    }
    const [a, b] = order === "AB" ? results : results.toReversed();
    if (!a || !b) throw new Error("Benchmark требует двух завершённых результатов пары");
    pairs.push({
      order,
      controlWall: a.wallSeconds,
      candidateWall: b.wallSeconds,
      controlRunId: a.runId,
      candidateRunId: b.runId,
    });
    await options.onProgress?.({ pairs, warmups, seed: options.seed, complete: false });
  }
  return { pairs, warmups, seed: options.seed, complete: true };
}
