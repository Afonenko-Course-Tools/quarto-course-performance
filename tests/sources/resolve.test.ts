import { strict as assert } from "node:assert";
import { join } from "node:path";
import { resolveSources } from "../../src/sources/resolve.ts";
import { verifySources } from "../../src/sources/prepare.ts";

Deno.test("candidate preparation refuses dirty or mismatched frozen checkout", async () => {
  const root = await Deno.makeTempDir();
  const git = async (args: string[]) => {
    const r = await new Deno.Command("git", {
      args: ["-C", root, ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(r.success, new TextDecoder().decode(r.stderr));
    return new TextDecoder().decode(r.stdout).trim();
  };
  try {
    await git(["init", "-q"]);
    await git(["config", "user.name", "Fixture"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    await Deno.writeTextFile(join(root, "file"), "original");
    await git(["add", "."]);
    await git(["commit", "-qm", "initial"]);
    const sha = await git(["rev-parse", "HEAD"]);
    const m = {
      schema_version: 2 as const,
      projectSource: "org/Java",
      replacements: [],
      experimentId: "e",
      sources: [{
        repository: "org/Java",
        sourceKind: "github-baseline" as const,
        remoteRef: "refs/heads/main",
        sha,
        fetchedAt: "2026-10-12T00:00:00Z",
        checkoutPath: root,
      }],
      packages: [],
      runtime: {},
    };
    await verifySources(m);
    await Deno.writeTextFile(join(root, "file"), "changed");
    await assert.rejects(() => verifySources(m), /изменён|dirty/i);
    await git(["checkout", "--", "file"]);
    await assert.rejects(
      () => verifySources({ ...m, sources: [{ ...m.sources[0], sha: "a".repeat(40) }] }),
      /SHA/i,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("frozen manifest reused without resolving a newer remote tip", async () => {
  const root = await Deno.makeTempDir();
  try {
    const manifest = {
      schema_version: 2,
      projectSource: "org/repo",
      replacements: [],
      experimentId: "frozen",
      sources: [{
        repository: "org/repo",
        sha: "a".repeat(40),
        remoteRef: "refs/heads/main",
        checkoutPath: root,
        sourceKind: "github-baseline",
        fetchedAt: "2026-10-12T00:00:00Z",
      }],
      packages: [],
      runtime: {},
    };
    await Deno.writeTextFile(join(root, "manifest.json"), JSON.stringify(manifest));
    assert.deepEqual(
      await resolveSources({
        sources: [{ repository: "org/repo", refPolicy: "remote-default-head" }],
        projectSource: "org/repo",
        replacements: [],
      }, root),
      manifest,
    );
    await assert.rejects(
      () =>
        resolveSources({
          sources: [{ repository: "different/repo", refPolicy: "remote-default-head" }],
          projectSource: "org/repo",
          replacements: [],
        }, root),
      /manifest|манифест/i,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("explicit annotated tag resolves to the peeled commit; unrelated refs never become baseline", async () => {
  const { selectRemoteRef } = await import("../../src/sources/resolve.ts");
  const tag = "a".repeat(40), commit = "b".repeat(40);
  assert.deepEqual(
    selectRemoteRef(`${tag}\trefs/tags/v2\n${commit}\trefs/tags/v2^{}\n`, {
      repository: "org/Java",
      refPolicy: "explicit-remote-ref",
      ref: "refs/tags/v2",
    }),
    { sha: commit, remoteRef: "refs/tags/v2" },
  );
  assert.throws(() =>
    selectRemoteRef(`${commit}\trefs/heads/other`, {
      repository: "org/Java",
      refPolicy: "explicit-remote-ref",
      ref: "refs/heads/chosen",
    })
  );
  assert.deepEqual(
    selectRemoteRef(`ref: refs/heads/main\tHEAD\n${commit}\tHEAD`, {
      repository: "org/Java",
      refPolicy: "remote-default-head",
    }),
    { sha: commit, remoteRef: "refs/heads/main" },
  );
});

Deno.test("v2 preparation uses explicit project source and preserves installed third party packages", async () => {
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
    const { git } = await import("../../src/sources/resolve.ts");
    const manifest = {
      schema_version: 2 as const,
      projectSource: "org/OtherCourse",
      replacements: [],
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
    assert.deepEqual(prepared.manifest.replacements, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("historical source manifest import is read only and never accepted by preparation", async () => {
  const { importSourceManifest, liveSourceManifest } = await import("../../src/config/types.ts");
  const { prepareVariant } = await import("../../src/sources/prepare.ts");
  const legacy = { experimentId: "history", sources: [], packages: [], runtime: {} };
  const bytes = JSON.stringify(legacy);
  assert.deepEqual(importSourceManifest(legacy, true), legacy);
  assert.equal(JSON.stringify(legacy), bytes);
  assert.throws(() => liveSourceManifest(legacy), /v2/);
  await assert.rejects(() => prepareVariant(legacy as never, "candidate", "/never-mutate"), /v2/);
});
