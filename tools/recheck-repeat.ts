// Повторное сравнение уже выполненных рендеров; исходный результат и outputs сохраняются.
import { join, resolve } from "node:path";
import { loadOwnerNormalizer } from "./owner-normalizer.ts";
import { compareOutputs } from "../src/analysis/outputs.ts";
import { hashFile } from "../src/sources/snapshot.ts";
const workspace = resolve(Deno.args[0]);
const normalizer = await loadOwnerNormalizer(
  Deno.args[2] ?? join(workspace, "candidate.manifest.json"),
);
const canonicalizeMetadata = normalizer.normalizeHtml;
const originalPath = join(workspace, "repeat-validation.json");
const original = JSON.parse(await Deno.readTextFile(originalPath));
const snapshotRoot = original.snapshotRoot ?? Deno.args[1];
if (!snapshotRoot) throw new Error("Нужен snapshotRoot исходного сравнения");
for (const id of [original.firstRunId, original.secondRunId]) {
  const run = JSON.parse(await Deno.readTextFile(join(workspace, "runs", id, "run.json")));
  if (
    run.buildExitCode !== 0 || run.mode !== "off" || run.cwd !== original.preparedRoot ||
    run.scenario !== "java-repeat-student"
  ) {
    throw new Error("Повторная проверка требует двух успешных off renders одной prepared copy");
  }
}
const comparisons = [];
for (const check of original.comparisons) {
  comparisons.push({
    path: check.path,
    ...await compareOutputs(
      join(snapshotRoot, check.path),
      join(original.preparedRoot, check.path),
      { normalizeHtml: canonicalizeMetadata },
    ),
  });
}
const result = {
  ...original,
  snapshotRoot: resolve(snapshotRoot),
  comparisons,
  equivalent: comparisons.every((c) => c.equivalent),
  recheck: {
    ownerNormalizer: normalizer.receipt,
    originalResult: originalPath,
    originalResultSha256: await hashFile(originalPath),
    normalizerSha256: await hashFile(
      new URL("../src/analysis/outputs.ts", import.meta.url).pathname,
    ),
    policy:
      "QRC owner metadata.ts + historical Core exercise attribute order; values, content and ZIP entries strict",
  },
};
await Deno.writeTextFile(
  join(workspace, "repeat-validation-rechecked.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify({ equivalent: result.equivalent, comparisons: comparisons.length }));
if (!result.equivalent) Deno.exit(4);
