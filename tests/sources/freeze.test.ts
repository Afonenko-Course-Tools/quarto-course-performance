import { quarto as nativeQuarto } from "../runtime.ts";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { freezeVariants } from "../../src/sources/freeze.ts";
import { git } from "../../src/sources/resolve.ts";

Deno.test("freeze pins generic trusted local candidates without Hyperfine and preserves previous manifests", async () => {
  const root = await Deno.makeTempDir();
  const oldPath = Deno.env.get("PATH")!;
  try {
    const baseline = join(root, "baseline"), candidate = join(root, "candidate");
    await Deno.mkdir(baseline);
    for (
      const args of [["init", "-q"], ["config", "user.name", "Fixture"], [
        "config",
        "user.email",
        "fixture@example.invalid",
      ]]
    ) await git(["-C", baseline, ...args]);
    await Deno.writeTextFile(join(baseline, "index.qmd"), "# Other course");
    await git(["-C", baseline, "add", "."]);
    await git(["-C", baseline, "commit", "-qm", "base"]);
    const baseSha = await git(["-C", baseline, "rev-parse", "HEAD"]);
    await git(["clone", "-q", baseline, candidate]);
    await git(["-C", candidate, "config", "user.name", "Fixture"]);
    await git(["-C", candidate, "config", "user.email", "fixture@example.invalid"]);
    await Deno.writeTextFile(join(candidate, "index.qmd"), "# Candidate");
    await git(["-C", candidate, "commit", "-qam", "candidate"]);
    const candidateSha = await git(["-C", candidate, "rev-parse", "HEAD"]);
    const manifest = {
      schema_version: 2,
      projectSource: "org/Other",
      replacements: [],
      experimentId: "base",
      sources: [{
        repository: "org/Other",
        sha: baseSha,
        sourceKind: "github-baseline",
        checkoutPath: baseline,
        remoteRef: "refs/heads/main",
        fetchedAt: "2026-10-24",
      }],
      packages: [],
      runtime: {},
    };
    const path = join(root, "baseline.json");
    await Deno.writeTextFile(path, JSON.stringify(manifest));
    const bin = join(root, "bin");
    await Deno.mkdir(bin);
    for (const name of ["hyperfine", "unzip"]) {
      await Deno.writeTextFile(
        join(bin, name),
        `#!/bin/sh\necho forbidden >> '${root}/forbidden'\nexit 91\n`,
      );
      await Deno.chmod(join(bin, name), 0o755);
    }
    Deno.env.set("PATH", bin + ":" + oldPath);
    const inputs = {
      baseline: path,
      variants: {
        upstream: { "org/Other": baseline },
        "clean-control": { "org/Other": baseline },
        candidate: { "org/Other": candidate },
      },
    };
    const workspace = join(root, "experiment");
    const frozen = await freezeVariants(inputs, workspace, nativeQuarto);
    assert.equal(frozen.candidate?.sources[0].sha, candidateSha);
    assert.equal(frozen.candidate?.sources[0].baseSha, baseSha);
    assert.equal(frozen.candidate?.sources[0].sourceKind, "local-candidate");
    assert.equal(frozen.candidate?.schema_version, 2);
    assert.equal(frozen.candidate?.runtime.hyperfine, undefined);
    await assert.rejects(() => Deno.stat(join(root, "forbidden")), Deno.errors.NotFound);
    const before = await Deno.readTextFile(join(workspace, "candidate.manifest.json"));
    await assert.rejects(() => freezeVariants(inputs, workspace, nativeQuarto), /закреплён/);
    assert.equal(await Deno.readTextFile(join(workspace, "candidate.manifest.json")), before);
    await assert.rejects(
      () =>
        freezeVariants(
          { ...inputs, variants: { ...inputs.variants, upstream: { "org/Other": candidate } } },
          join(root, "bad"),
          nativeQuarto,
        ),
      /SHA/,
    );
  } finally {
    Deno.env.set("PATH", oldPath);
    await Deno.remove(root, { recursive: true });
  }
});
