import { strict as assert } from "node:assert";
import { join } from "node:path";
import { loadOwnerNormalizer } from "../../tools/owner-normalizer.ts";
Deno.test("owner normalization executes the frozen Git blob and records its provenance", async () => {
  const root = await Deno.makeTempDir();
  const git = async (...args: string[]) => {
    const out = await new Deno.Command("git", {
      args: ["-C", root, ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(out.success, true, new TextDecoder().decode(out.stderr));
    return new TextDecoder().decode(out.stdout).trim();
  };
  try {
    await git("init", "-q");
    const modulePath = "_extensions/reference-catalog/infrastructure/metadata.ts";
    await Deno.mkdir(join(root, "_extensions/reference-catalog/infrastructure"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(root, modulePath),
      'export const canonicalizeMetadata=(html:string)=>"frozen:"+html;\n',
    );
    await git("add", modulePath);
    await git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const sha = await git("rev-parse", "HEAD");
    const manifest = join(root, "manifest.json");
    await Deno.writeTextFile(
      manifest,
      JSON.stringify({
        sources: [{
          repository: "Afonenko-Course-Tools/quarto-reference-catalog",
          sha,
          checkoutPath: root,
        }],
      }),
    );
    await Deno.writeTextFile(
      join(root, modulePath),
      'throw new Error("dirty checkout must not execute");',
    );
    const result = await loadOwnerNormalizer(manifest);
    assert.equal(result.normalizeHtml("value"), "frozen:value");
    assert.equal(result.receipt.sha, sha);
    assert.equal(result.receipt.path, modulePath);
    assert.match(result.receipt.sha256, /^[0-9a-f]{64}$/);
    await Deno.writeTextFile(manifest, JSON.stringify({ sources: [] }));
    await assert.rejects(() => loadOwnerNormalizer(manifest), /отсутствует QRC/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
