import { join, resolve } from "node:path";
import { validateConfig } from "../config/validate.ts";
import { resolveSources } from "../sources/resolve.ts";
import { freezeVariants } from "../sources/freeze.ts";
import { prepareVariant } from "../sources/prepare.ts";
import { executablePath, probeQuarto } from "../adapters/quarto/capabilities.ts";
import { executeScenario } from "../runner/execute.ts";
import { benchmarkPair } from "../runner/benchmark.ts";
import { hashFile } from "../sources/snapshot.ts";
import { compareBenchmarks } from "../analysis/compare.ts";
import { type NormalizedRun, normalizeRun } from "../analysis/normalize.ts";
import {
  assertWritableExperiment,
  importHistoricalExperiment,
  writeExperimentReport,
} from "../analysis/report.ts";
import {
  importSourceManifest,
  liveSourceManifest,
  type Mode,
  type Variant,
} from "../config/types.ts";
function parseFlags(args: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let n = 0; n < args.length; n++) {
    if (args[n] === "--import-historical") {
      if (flags[args[n]]) throw new Error("Повтор --import-historical");
      flags[args[n]] = "true";
      continue;
    }
    if (
      !args[n].startsWith("--") || !args[n + 1] || args[n + 1].startsWith("--") || flags[args[n]]
    ) {
      throw new Error("Некорректные/повторные CLI параметры");
    }
    if (
      ![
        "--output",
        "--quarto",
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
    n++;
  }
  return flags;
}
export async function experimentCommand(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  const flags = parseFlags(args);
  if (
    !["sources", "freeze", "run", "benchmark", "report", "verify", "capabilities"].includes(command)
  ) throw new Error("Команды: sources, freeze, run, benchmark, report, verify, capabilities");
  if (
    (flags["--import-historical"] || flags["--output"]) && !["report", "verify"].includes(command)
  ) {
    throw new Error("Исторический импорт разрешён только report/verify");
  }
  if (Boolean(flags["--import-historical"]) !== Boolean(flags["--output"])) {
    throw new Error("Необходимы вместе --import-historical и явный --output");
  }
  if (command === "capabilities") {
    console.log(
      JSON.stringify(
        await probeQuarto(flags["--quarto"] ?? Deno.env.get("QUARTO") ?? "quarto"),
        null,
        2,
      ),
    );
    return 0;
  }
  const workspace = resolve(flags["--workspace"] ?? ".workspace/experiment");
  const historical = command === "report" || command === "verify";
  if (!historical && !flags["--config"]) throw new Error("Необходим --config v2");
  const config = historical
    ? undefined
    : validateConfig(JSON.parse(await Deno.readTextFile(flags["--config"])));
  const quarto = flags["--quarto"] ?? config?.runtime?.quarto ?? "quarto";
  function assertSelection(
    manifest: { projectSource: string; replacements: unknown; sources: { repository: string }[] },
  ) {
    if (
      !config || manifest.projectSource !== config.projectSource ||
      JSON.stringify(manifest.replacements) !== JSON.stringify(config.replacements) ||
      JSON.stringify(manifest.sources.map((s) => s.repository).sort()) !==
        JSON.stringify(config.sources.map((s) => s.repository).sort())
    ) throw new Error("Config расходится с закреплённым source manifest");
  }
  if (command === "freeze") {
    if (!flags["--inputs"]) throw new Error("Необходим --inputs");
    const inputs = JSON.parse(await Deno.readTextFile(flags["--inputs"]));
    assertSelection(liveSourceManifest(JSON.parse(await Deno.readTextFile(inputs.baseline))));
    const manifests = await freezeVariants(
      inputs,
      workspace,
      quarto,
    );
    console.log(JSON.stringify(manifests));
    return 0;
  }
  if (command === "sources") {
    const manifest = await resolveSources(config!, workspace);
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
  const manifestFor = async (variant: Variant) => {
    const manifest = liveSourceManifest(
      JSON.parse(await Deno.readTextFile(join(workspace, variant + ".manifest.json"))),
    );
    assertSelection(manifest);
    return manifest;
  };
  const runRoot = join(workspace, "runs"),
    env = {
      XDG_CACHE_HOME: join(workspace, "cache"),
      QUARTO_RUN_NO_NETWORK: "true",
      QUARTO: quarto,
    };
  if (command === "run" || command === "benchmark") {
    if (!config) throw new Error("Необходим --config v2");
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
      if (!config.benchmark) {
        throw new Error("Необходима benchmark policy с явным maxSlowdownRatio");
      }
      // Hyperfine требуется только выбранному действию benchmark, до подготовки копий.
      const hyperfinePath = await executablePath("hyperfine", Deno.env.toObject());
      const hyperfine = await new Deno.Command(hyperfinePath, {
        args: ["--version"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!hyperfine.success) throw new Error("Hyperfine недоступен");
      const hyperfineReceipt = {
        path: hyperfinePath,
        version: new TextDecoder().decode(hyperfine.stdout).trim(),
        hash: await hashFile(hyperfinePath),
      };
      const a = await prepare(left as Variant),
        b = await prepare(right as Variant),
        seed = Number(flags["--seed"] ?? 42),
        pairs = Number(flags["--pairs"] ?? config.benchmark.pairs ?? 10);
      for (const prepared of [a, b]) prepared.manifest.runtime.hyperfine = hyperfineReceipt;
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
          config.benchmark.maxSlowdownRatio,
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
      : await (await import("../runner/diagnostic.ts")).prepareDiagnostic(
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
    if (flags["--import-historical"]) {
      const report = await importHistoricalExperiment(
        workspace,
        flags["--output"],
        flags["--experiment"],
      );
      console.log(`Отчёт: ${join(report.outputDirectory, "report.md")}`);
      return report.exitCode;
    }
    const manifest = importSourceManifest(
      JSON.parse(await Deno.readTextFile(join(workspace, "candidate.manifest.json"))),
      true,
    );
    await assertWritableExperiment(manifest, workspace);
    async function* runs(): AsyncGenerator<NormalizedRun> {
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
          if (meta.request.mode !== "off") {
            yield await normalizeRun(dir);
          } else {
            yield {
              runId: meta.runId,
              events: [],
              executors: {},
              dataValid: meta.dataValid,
              quality: meta.quality,
            };
          }
        }
      }
    }
    const experiment = flags["--experiment"];
    if (experiment && experiment !== manifest.experimentId) {
      throw new Error("Неверный experiment id");
    }
    const report = await writeExperimentReport(manifest, runs(), workspace);
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
      if (meta.outcome.code !== 0) return 3;
    }
    return report.dataValid ? 0 : 4;
  }
  throw new Error("Команды: sources, freeze, run, benchmark, report, verify, capabilities");
}
