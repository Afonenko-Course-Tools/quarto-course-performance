import { join, resolve } from "node:path";
import { validateConfig } from "./config/validate.ts";
import { resolveSources } from "./sources/resolve.ts";
import { freezeVariants } from "./sources/freeze.ts";
import { prepareVariant } from "./sources/prepare.ts";
import { probeQuarto } from "./adapters/quarto/capabilities.ts";
import { executeScenario } from "./runner/execute.ts";
import { benchmarkPair } from "./runner/benchmark.ts";
import { compareBenchmarks } from "./analysis/compare.ts";
import { type NormalizedRun, normalizeRun } from "./analysis/normalize.ts";
import { writeExperimentReport } from "./analysis/report.ts";
import type { Mode, SourceManifest, Variant } from "./config/types.ts";
const [command, ...args] = Deno.args, flags: Record<string, string> = {};
function parseFlags() {
  for (let n = 0; n < args.length; n += 2) {
    if (!args[n].startsWith("--") || !args[n + 1] || flags[args[n]]) {
      throw new Error("Некорректные/повторные CLI параметры");
    }
    if (
      ![
        "--workspace",
        "--config",
        "--inputs",
        "--scenario",
        "--left",
        "--right",
        "--seed",
        "--pairs",
        "--mode",
        "--variant",
        "--experiment",
      ].includes(args[n])
    ) throw new Error("Неизвестный CLI параметр");
    flags[args[n]] = args[n + 1];
  }
}
async function main(): Promise<number> {
  parseFlags();
  const workspace = resolve(flags["--workspace"] ?? ".workspace/experiment"),
    config = validateConfig(
      JSON.parse(await Deno.readTextFile(flags["--config"] ?? "scenarios/java.json")),
    );
  const quarto = config.runtime?.quarto ?? "quarto";
  if (command === "freeze") {
    if (!flags["--inputs"]) throw new Error("Необходим --inputs");
    const manifests = await freezeVariants(
      JSON.parse(await Deno.readTextFile(flags["--inputs"])),
      workspace,
      quarto,
    );
    console.log(JSON.stringify(manifests));
    return 0;
  }
  if (command === "sources") {
    const manifest = await resolveSources(config.sources, workspace);
    const caps = await probeQuarto(quarto);
    manifest.runtime = caps.runtime;
    await Deno.writeTextFile(
      join(workspace, "upstream.manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await Deno.writeTextFile(
      join(workspace, "capabilities.json"),
      JSON.stringify(caps, null, 2) + "\n",
    );
    console.log(JSON.stringify(manifest));
    return 0;
  }
  const manifestFor = async (variant: Variant): Promise<SourceManifest> =>
    JSON.parse(await Deno.readTextFile(join(workspace, variant + ".manifest.json")));
  const runRoot = join(workspace, "runs"),
    env = {
      XDG_CACHE_HOME: join(workspace, "cache"),
      QUARTO_RUN_NO_NETWORK: "true",
      QUARTO: quarto,
    };
  if (command === "run" || command === "benchmark") {
    const runtimeRegistry = (await manifestFor("candidate")).runtime.runtimeRegistry?.path;
    const scenario = config.scenarios.find((s) => s.id === flags["--scenario"]);
    if (!scenario) throw new Error("Неизвестный --scenario");
    const prepare = async (variant: Variant) =>
      await prepareVariant(
        await manifestFor(variant),
        variant,
        await Deno.makeTempDir({ dir: workspace, prefix: "prepared-" }),
      );
    if (command === "benchmark") {
      const left = flags["--left"] ?? "clean-control", right = flags["--right"] ?? "candidate";
      if (
        !["upstream", "clean-control", "candidate"].includes(left) ||
        !["upstream", "clean-control", "candidate"].includes(right)
      ) throw new Error("Неизвестный variant");
      const a = await prepare(left as Variant),
        b = await prepare(right as Variant),
        seed = Number(flags["--seed"] ?? 42),
        pairs = Number(flags["--pairs"] ?? (scenario.id.startsWith("java-full-") ? 5 : 10));
      await Deno.mkdir(join(workspace, "benchmarks"), { recursive: true });
      const series = await benchmarkPair({ ...scenario, executable: quarto }, a, b, {
          pairs,
          seed,
          executeOptions: {
            outputRoot: runRoot,
            env,
            cleanPaths: config.cleanPaths,
            useHyperfine: true,
            runtimeRegistry,
          },
          onProgress: async (progress) => {
            await Deno.writeTextFile(
              join(workspace, "benchmarks", scenario.id + ".partial.json"),
              JSON.stringify(
                { scenario: scenario.id, left, right, ...progress as object },
                null,
                2,
              ) + "\n",
            );
          },
        }),
        comparison = compareBenchmarks(
          series.pairs.map((p) => p.candidateWall / p.controlWall),
          seed,
        );
      const result = { scenario: scenario.id, left, right, ...series, comparison };
      await Deno.mkdir(join(workspace, "benchmarks"), { recursive: true });
      await Deno.writeTextFile(
        join(workspace, "benchmarks", scenario.id + ".json"),
        JSON.stringify(result, null, 2) + "\n",
      );
      console.log(JSON.stringify(result));
      return comparison.status === "PASS" ? 0 : 5;
    }
    const mode = (flags["--mode"] ?? scenario.mode) as Mode,
      variant = (flags["--variant"] ?? "candidate") as Variant;
    if (
      !["off", "summary", "cpu", "trace"].includes(mode) ||
      !["upstream", "clean-control", "candidate"].includes(variant)
    ) throw new Error("Неизвестный mode/variant");
    const prepared = await prepare(variant), actual = { ...scenario, executable: quarto, mode };
    const diagnostic = mode === "off"
      ? undefined
      : await (await import("./runner/diagnostic.ts")).prepareDiagnostic(
        actual,
        prepared,
        await Deno.makeTempDir({ dir: workspace, prefix: "diagnostic-" }),
        quarto,
      );
    const result = await executeScenario(actual, prepared, mode, {
      outputRoot: runRoot,
      env,
      cleanPaths: config.cleanPaths,
      preparation: diagnostic?.preparation,
      diagnosticEnv: diagnostic?.env,
      coverage: diagnostic?.coverage,
      runtimeRegistry,
    });
    if (diagnostic) {
      const normalized = await normalizeRun(result.outputDirectory);
      const names = Object.values(normalized.executors).flatMap((e) =>
        Object.keys(e.counters as object)
      );
      const observations = Object.fromEntries(
        diagnostic.coverage.requestedExtensions.map((ext) => [
          ext,
          names.some((name) => name.startsWith(`calls.${ext}.`)) ? "observed" : "not-observed",
        ]),
      );
      await Deno.writeTextFile(
        join(result.outputDirectory, "coverage.json"),
        JSON.stringify({ ...diagnostic.coverage, observations }, null, 2) + "\n",
      );
    }
    await Deno.writeTextFile(
      join(result.outputDirectory, "manifest.json"),
      JSON.stringify(prepared.manifest, null, 2) + "\n",
    );
    console.log(JSON.stringify(result));
    return result.buildExitCode ? 3 : result.dataValid ? 0 : 4;
  }
  if (command === "report" || command === "verify") {
    const manifest = await manifestFor("candidate"), runs: NormalizedRun[] = [];
    for await (const item of Deno.readDir(runRoot)) {
      if (item.isDirectory) {
        const dir = join(runRoot, item.name);
        let meta;
        try {
          meta = JSON.parse(await Deno.readTextFile(join(dir, "run.json")));
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) continue;
          throw e;
        }
        if (meta.mode !== "off") runs.push(await normalizeRun(dir));
      }
    }
    const experiment = flags["--experiment"];
    if (experiment && experiment !== manifest.experimentId) {
      throw new Error("Неверный experiment id");
    }
    await writeExperimentReport(manifest, runs, workspace);
    console.log(`Отчёт: ${join(workspace, "report.md")}`);
    for await (const item of Deno.readDir(runRoot)) {
      if (!item.isDirectory) continue;
      let meta;
      try {
        meta = JSON.parse(await Deno.readTextFile(join(runRoot, item.name, "run.json")));
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return 4;
        throw e;
      }
      if (meta.buildExitCode !== 0) return 3;
    }
    return runs.some((r) => !r.dataValid) ? 4 : 0;
  }
  if (command === "capabilities") {
    console.log(JSON.stringify(await probeQuarto(quarto), null, 2));
    return 0;
  }
  throw new Error("Команды: sources, freeze, run, benchmark, report, verify, capabilities");
}
if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(2);
  }
}
