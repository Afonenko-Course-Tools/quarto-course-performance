// Повторное сравнение уже выполненных рендеров; исходный результат и outputs сохраняются.
import { join, resolve } from "node:path";
import { compareOutputs } from "../src/analysis/outputs.ts";
const workspace = resolve(Deno.args[0]);
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
      { outputPolicy: "java-pilot-core-qrc-v1" },
    ),
  });
}
// Старое свидетельство остаётся в исходном файле, а не наследуется как новая приёмка.
const {
  equivalent: _previousEquivalent,
  ownerNormalizer: _previousOwnerNormalizer,
  normalization: _previousNormalization,
  ...originalMetadata
} = original;
const result = {
  ...originalMetadata,
  snapshotRoot: resolve(snapshotRoot),
  comparisons,
  checkedContentEqual: comparisons.every((c) => c.checkedContentEqual),
  htmlBytesCompared: false,
  recheck: {
    originalResult: originalPath,
  },
};
await Deno.writeTextFile(
  join(workspace, "repeat-validation-rechecked.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    checkedContentEqual: result.checkedContentEqual,
    htmlBytesCompared: false,
    comparisons: comparisons.length,
  }),
);
if (!result.checkedContentEqual) Deno.exit(4);
