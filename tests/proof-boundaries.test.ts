import { strict as assert } from "node:assert";
import { join } from "node:path";
import { liveSourceManifest } from "../src/config/types.ts";
import { observePackages } from "../src/runner/package-coverage.ts";
import { importHistoricalExperiment } from "../src/analysis/report.ts";
import { record } from "./report/fixture.ts";

const selection = {
  schema_version: 2,
  projectSource: "org/course",
  replacements: [],
  experimentId: "e",
  sources: [{
    repository: "org/course",
    sourceKind: "local-candidate",
    remoteRef: "main",
    sha: "a".repeat(40),
    fetchedAt: "2026-11-05",
    checkoutPath: "/old/course",
  }],
  packages: [],
  runtime: { quarto: { path: "/old/quarto", version: "1.11.6" } },
};

Deno.test("live inputs отклоняют удалённые digest поля без совместимого договора", () => {
  assert.deepEqual(liveSourceManifest(selection), selection);
  assert.throws(() =>
    liveSourceManifest({
      ...selection,
      runtime: { quarto: { ...selection.runtime.quarto, hash: "a".repeat(64) } },
    })
  );
  assert.throws(() =>
    liveSourceManifest({
      ...selection,
      packages: [{
        repository: "org/course",
        ownerSha: "a".repeat(40),
        extensionId: "core",
        sourcePath: "/old/core",
        destinationPaths: ["/old/course/_extensions/core"],
        packageHash: "a".repeat(64),
      }],
    })
  );
});

Deno.test("старые package proof rows не попадают в действительные наблюдения", () => {
  const old = JSON.parse(
    '{"requested":[{"extensionId":"core","installed":true}],"packages":[{"sha256":"old"}]}',
  );
  const observed = observePackages(old, [], true);
  assert.deepEqual(observed, { observationStatus: "valid", observations: [] });
});

Deno.test("исторический v2 читается без старого preparation proof и без изменения архива", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const layout of ["completion", "outcome"]) {
      const source = join(root, layout),
        run = join(source, "runs/r"),
        output = join(root, "output-" + layout);
      await Deno.mkdir(run, { recursive: true });
      await Deno.writeTextFile(join(source, "candidate.manifest.json"), JSON.stringify(selection));
      const { preparedScripts: _scripts, ...base } = record(run, "r");
      const rawValue = {
        ...base,
        mode: "off",
        experimentId: "e",
        preparation: [{
          kind: "bootstrap",
          path: "/old/init.lua",
          sourceHash: "old",
          preparedHash: "old",
        }],
      };
      const { completion, ...old } = rawValue;
      const raw = JSON.stringify(
        layout === "completion"
          ? rawValue
          : { ...old, outcome: { ...completion.native, stdioMode: base.stdioMode } },
      );
      await Deno.writeTextFile(join(run, "run.json"), raw);
      await importHistoricalExperiment(source, output);
      const imported = JSON.parse(await Deno.readTextFile(join(output, "runs/r/run.json")));
      assert.deepEqual(imported.preparedScripts, []);
      assert.equal(imported.completion.native.code, 7);
      assert.equal("preparation" in imported, false);
      assert.equal(await Deno.readTextFile(join(run, "run.json")), raw);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
