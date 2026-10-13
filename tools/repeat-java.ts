// Два рендера одной disposable copy без очистки outputs; функциональная проверка повторного запуска.
import { join, resolve } from "node:path";
import type { SourceManifest } from "../src/config/types.ts";
import { validateConfig } from "../src/config/validate.ts";
import { prepareVariant } from "../src/sources/prepare.ts";
import { executeScenario } from "../src/runner/execute.ts";
import { compareOutputs } from "../src/analysis/outputs.ts";
import { copyTree } from "../src/sources/snapshot.ts";
const workspace = resolve(Deno.args[0]);
const config = validateConfig(
  JSON.parse(await Deno.readTextFile(new URL("../scenarios/java.json", import.meta.url))),
);
const scenario = config.scenarios.find((s) => s.id === "java-repeat-student")!;
const manifest: SourceManifest = JSON.parse(
  await Deno.readTextFile(join(workspace, "candidate.manifest.json")),
);
const prepared = await prepareVariant(
  manifest,
  "candidate",
  await Deno.makeTempDir({ dir: workspace, prefix: "repeat-" }),
);
const quarto = config.runtime?.quarto ?? "quarto";
const options = {
  outputRoot: join(workspace, "runs"),
  env: { XDG_CACHE_HOME: join(workspace, "cache"), QUARTO_RUN_NO_NETWORK: "true", QUARTO: quarto },
};
const first = await executeScenario({ ...scenario, executable: quarto }, prepared, "off", options);
if (first.buildExitCode) throw new Error("Первый render неуспешен");
const snapshot = await Deno.makeTempDir({ dir: workspace, prefix: "repeat-outputs-" });
const paths: string[] = [];
for (const path of (config.cleanPaths ?? []).filter((p) => p.endsWith("student"))) {
  try {
    await copyTree(join(prepared.root, path), join(snapshot, path));
    paths.push(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}
if (!paths.length) throw new Error("Нет outputs первого render");
const second = await executeScenario({ ...scenario, executable: quarto }, prepared, "off", options);
if (second.buildExitCode) throw new Error("Повторный render неуспешен");
const comparisons = [];
for (const path of paths) {
  comparisons.push({
    path,
    ...await compareOutputs(join(snapshot, path), join(prepared.root, path)),
  });
}
const result = {
  experimentId: manifest.experimentId,
  cachePolicy: scenario.cachePolicy,
  preparedRoot: prepared.root,
  firstRunId: first.runId,
  secondRunId: second.runId,
  comparisons,
  equivalent: comparisons.every((c) => c.equivalent),
  performanceAcceptance: "not-a-paired-benchmark",
};
await Deno.writeTextFile(
  join(workspace, "repeat-validation.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
if (!result.equivalent) Deno.exit(4);
