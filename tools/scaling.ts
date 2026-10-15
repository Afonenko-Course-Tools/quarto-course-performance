// Native synthetic workload владельца Core; длительности не используются как off acceptance.
import { join, resolve } from "node:path";
import { copyTree, hashFile } from "../src/sources/snapshot.ts";
import { git } from "../src/sources/resolve.ts";
import { verifySources } from "../src/sources/prepare.ts";
import { prepareDiagnostic } from "../src/runner/diagnostic.ts";
import { executeScenario } from "../src/runner/execute.ts";
import { normalizeRun } from "../src/analysis/normalize.ts";
import { compareOutputs } from "../src/analysis/outputs.ts";
import type { PreparedVariant, Scenario, SourceManifest } from "../src/config/types.ts";
const [ownerArg, outputArg] = Deno.args;
if (!ownerArg || !outputArg) throw new Error("Использование: scaling.ts CORE_CHECKOUT OUTPUT");
const owner = await Deno.realPath(ownerArg), output = resolve(outputArg);
await Deno.mkdir(output, { recursive: true });
const manifest: SourceManifest = {
  experimentId: crypto.randomUUID(),
  packages: [],
  runtime: {},
  sources: [{
    repository: "Afonenko-Course-Tools/quarto-course",
    sourceKind: "local-candidate",
    remoteRef: await git(["-C", owner, "rev-parse", "--abbrev-ref", "HEAD"]),
    sha: await git(["-C", owner, "rev-parse", "HEAD"]),
    checkoutPath: owner,
    fetchedAt: new Date().toISOString(),
  }],
};
await verifySources(manifest);
const rows = [];
for (const factor of [1, 2, 4]) {
  const root = join(output, "input-" + factor);
  await Deno.mkdir(root, { recursive: false });
  for (const extension of ["course-core", "course-presentation", "course-navigation"]) {
    await copyTree(join(owner, "_extensions", extension), join(root, "_extensions", extension));
  }
  const config =
    "project:\n  type: book\n  output-dir: _book\n  pre-render: _extensions/course-core/entrypoints/pre.ts\n  post-render: _extensions/course-core/entrypoints/post.ts\nbook:\n  title: Synthetic Core\n  chapters: [index.qmd]\nformat: html\ncourse: {id: synthetic-core, view: full}\nexercise-bank: true\nexercise-statement-visibility: open\nfilters: [course-core]\n";
  await Deno.writeTextFile(join(root, "_quarto.yml"), config);
  await Deno.writeTextFile(
    join(root, "index.qmd"),
    "# Synthetic Core\n\n" +
      Array.from(
        { length: factor },
        (_, i) =>
          `:::: {#exr-scale-${
            i + 1
          } course-role=independent-study difficulty=introductory time=10}\nУсловие ${
            i + 1
          }.\n\n::: {#sol-scale-${i + 1}}\nРешение ${i + 1}.\n:::\n::::\n\n`,
      ).join(""),
  );
  const scenario: Scenario = {
    id: `synthetic-core-${factor}`,
    project: "Java",
    cwd: ".",
    executable: "quarto",
    args: ["render"],
    courseProfile: "full",
    cachePolicy: "clean-output",
    mode: "summary",
    scope: {
      modules: [],
      extensions: ["course-core", "course-navigation", "course-presentation"],
      strict: true,
    },
    resources: { wall: true, cpu: true, peakRss: true },
  };
  const prepared: PreparedVariant = { root, variant: "candidate", manifest };
  const options = {
    outputRoot: join(output, "runs"),
    cleanPaths: ["_book"],
    env: { XDG_CACHE_HOME: join(output, "cache"), QUARTO_RUN_NO_NETWORK: "true" },
  };
  const off = await executeScenario(scenario, prepared, "off", options);
  if (off.buildExitCode) throw new Error("Synthetic off failed: " + off.outputDirectory);
  const ordinary = join(output, "ordinary-" + factor);
  await copyTree(join(root, "_book"), ordinary);
  const diagnostic = await prepareDiagnostic(
    scenario,
    prepared,
    join(output, "diagnostic-" + factor),
  );
  const summary = await executeScenario(scenario, prepared, "summary", {
    ...options,
    diagnosticEnv: diagnostic.env,
    preparation: diagnostic.preparation,
    coverage: diagnostic.coverage,
  });
  if (summary.buildExitCode || !summary.dataValid) {
    throw new Error("Synthetic summary failed: " + summary.outputDirectory);
  }
  const normalized = await normalizeRun(summary.outputDirectory),
    counters: Record<string, number> = {};
  for (const executor of Object.values(normalized.executors)) {
    for (const [name, value] of Object.entries(executor.counters as Record<string, number>)) {
      counters[name] = (counters[name] ?? 0) + value;
    }
  }
  const equivalence = await compareOutputs(ordinary, join(root, "_book"));
  rows.push({
    factor,
    inputHash: await hashFile(join(root, "index.qmd")),
    offRunId: off.runId,
    summaryRunId: summary.runId,
    counters,
    equivalence,
  });
  await Deno.writeTextFile(
    join(output, "scaling.json"),
    JSON.stringify({ manifest, rows }, null, 2) + "\n",
  );
  if (!equivalence.equivalent) throw new Error("Synthetic outputs differ");
}
console.log(JSON.stringify(rows.map((r) => ({
  factor: r.factor,
  full: r.counters["walk_api_calls.full-document"],
  fragment: r.counters["walk_api_calls.fragment"],
  collect: r.counters["calls.course-core.pedagogy.collect.collect"],
  equivalent: r.equivalence.equivalent,
}))));
