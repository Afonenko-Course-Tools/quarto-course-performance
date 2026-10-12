import { strict as assert } from "node:assert";
import { join } from "node:path";
import { resolveSources } from "../../src/sources/resolve.ts";

Deno.test("frozen manifest reused without resolving a newer remote tip", async () => {
  const root = await Deno.makeTempDir();
  try {
    const manifest = { experimentId: "frozen", sources: [{repository: "org/repo",sha: "a".repeat(40),remoteRef:"refs/heads/main",checkoutPath:root,sourceKind:"github-baseline",fetchedAt:"2026-10-12T00:00:00Z"}], packages: [], runtime: {} };
    await Deno.writeTextFile(join(root,"manifest.json"), JSON.stringify(manifest));
    assert.deepEqual(await resolveSources([{repository:"org/repo",refPolicy:"remote-default-head"}],root), manifest);
    await assert.rejects(() => resolveSources([{repository:"different/repo",refPolicy:"remote-default-head"}],root), /manifest|манифест/i);
  } finally { await Deno.remove(root,{recursive:true}); }
});
