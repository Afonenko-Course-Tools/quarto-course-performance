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
      await resolveSources([{ repository: "org/repo", refPolicy: "remote-default-head" }], root),
      manifest,
    );
    await assert.rejects(
      () =>
        resolveSources([{ repository: "different/repo", refPolicy: "remote-default-head" }], root),
      /manifest|манифест/i,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
