import { strict as assert } from "node:assert";
import { join } from "node:path";

Deno.test("prepared variant exports committed third party packages and rejects symlinks", async () => {
  const { prepareVariant } = await import("../../src/sources/prepare.ts");
  const root = await Deno.makeTempDir();
  try {
    const source = join(root, "OtherCourse"), work = join(root, "work");
    await Deno.mkdir(join(source, "_extensions/third/extra"), { recursive: true });
    await Deno.mkdir(work);
    await Deno.writeTextFile(
      join(source, "_extensions/third/extra/_extension.yml"),
      "version: preserved",
    );
    for (
      const args of [
        ["init", "-q"],
        ["config", "user.name", "Fixture"],
        ["config", "user.email", "fixture@example.invalid"],
        ["add", "."],
        ["commit", "-qm", "fixture"],
      ]
    ) {
      const out = await new Deno.Command("git", {
        args: ["-C", source, ...args],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(out.success);
    }
    const { git } = await import("../../src/sources/git.ts");
    const manifest = {
      schema_version: 2 as const,
      projectSource: "org/OtherCourse",
      experimentId: "generic",
      sources: [{
        repository: "org/OtherCourse",
        sha: await git(["-C", source, "rev-parse", "HEAD"]),
        sourceKind: "local-candidate" as const,
        baseSha: "a".repeat(40),
        remoteRef: "HEAD",
        checkoutPath: source,
        fetchedAt: "2026-10-24",
      }],
      packages: [],
      runtime: {},
    };
    await Deno.writeTextFile(join(source, ".git/info/exclude"), ".quarto/\n");
    await Deno.mkdir(join(source, ".quarto/course-perf/runs/old"), { recursive: true });
    await Deno.writeTextFile(join(source, ".quarto/course-perf/runs/old/events.json"), "private");
    const prepared = await prepareVariant(manifest, "candidate", work);
    await assert.rejects(
      () => Deno.stat(join(prepared.root, ".quarto/course-perf")),
      Deno.errors.NotFound,
    );
    assert.equal(
      await Deno.readTextFile(join(prepared.root, "_extensions/third/extra/_extension.yml")),
      "version: preserved",
    );
    await Deno.symlink("/tmp", join(source, "unsafe-link"));
    await git(["-C", source, "add", "unsafe-link"]);
    await git(["-C", source, "commit", "-qm", "unsafe link"]);
    const linked = {
      ...manifest,
      sources: manifest.sources.map((entry) => ({ ...entry, sha: "" })),
    };
    linked.sources[0]!.sha = await git(["-C", source, "rev-parse", "HEAD"]);
    await assert.rejects(() => prepareVariant(linked, "upstream", work), /Символическая ссылка/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("historical source manifest import is read only and never accepted by preparedScripts", async () => {
  const { importSourceManifest, liveSourceManifest } = await import("../../src/config/types.ts");
  const { prepareVariant } = await import("../../src/sources/prepare.ts");
  const legacy = { experimentId: "history", sources: [], packages: [], runtime: {} };
  const bytes = JSON.stringify(legacy);
  assert.deepEqual(importSourceManifest(legacy, true), legacy);
  assert.equal(JSON.stringify(legacy), bytes);
  assert.throws(() => liveSourceManifest(legacy), /v2/);
  await assert.rejects(() => prepareVariant(legacy as never, "candidate", "/never-mutate"), /v2/);
});

Deno.test("live preparation rejects legacy replacement selection while historical reports retain it", async () => {
  const { importSourceManifest, liveSourceManifest } = await import("../../src/config/types.ts");
  const legacy = {
    schema_version: 2,
    projectSource: "org/course",
    experimentId: "old",
    runtime: {},
    packages: [],
    sources: [{
      repository: "org/course",
      sourceKind: "local-candidate",
      sha: "a".repeat(40),
      remoteRef: "HEAD",
      fetchedAt: "old",
      checkoutPath: "/old",
    }],
    replacements: [{
      repository: "org/extension",
      extensionId: "example",
      destinations: ["_extensions/example"],
    }],
  };
  assert.deepEqual(importSourceManifest(legacy, true), legacy);
  assert.throws(() => liveSourceManifest(legacy), /replacements/);
});
