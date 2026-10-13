// Используется именно Git blob закреплённой версии владельца, а не текущий dirty checkout.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SourceManifest } from "../src/config/types.ts";
import { hashFile } from "../src/sources/snapshot.ts";
export async function loadOwnerNormalizer(manifestPath: string) {
  const manifest: SourceManifest = JSON.parse(await Deno.readTextFile(manifestPath));
  const source = manifest.sources.find((s) => s.repository.endsWith("/quarto-reference-catalog"));
  if (!source) throw new Error("В manifest отсутствует QRC");
  const path = "_extensions/reference-catalog/infrastructure/metadata.ts";
  const blob = await new Deno.Command("git", {
    args: ["-C", source.checkoutPath, "show", `${source.sha}:${path}`],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!blob.success) {
    throw new Error("Закреплённая версия QRC не предоставляет нормализацию metadata");
  }
  const dir = await Deno.makeTempDir({ prefix: "qrc-normalizer-" });
  try {
    const file = join(dir, "metadata.ts");
    await Deno.writeFile(file, blob.stdout);
    const { canonicalizeMetadata } = await import(pathToFileURL(file).href);
    if (typeof canonicalizeMetadata !== "function") {
      throw new Error("Невалидный QRC normalizer API");
    }
    return {
      normalizeHtml: canonicalizeMetadata as (html: string, sourceRoot?: string) => string,
      receipt: {
        manifest: resolve(manifestPath),
        repository: source.repository,
        sha: source.sha,
        path,
        sha256: await hashFile(file),
      },
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
