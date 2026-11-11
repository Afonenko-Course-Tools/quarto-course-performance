import { object, parseObject, string } from "../src/json.ts";
// Используется именно Git blob закреплённой версии владельца, а не текущий dirty checkout.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { importSourceManifest } from "../src/config/types.ts";
export async function loadOwnerNormalizer(manifestPath: string) {
  const manifest = importSourceManifest(parseObject(await Deno.readTextFile(manifestPath)), true);
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
    const imported: unknown = await import(pathToFileURL(file).href);
    const canonicalizeMetadata = object(imported).canonicalizeMetadata;
    if (typeof canonicalizeMetadata !== "function") {
      throw new Error("Невалидный QRC normalizer API");
    }
    return {
      normalizeHtml: (html: string, sourceRoot?: string): string => {
        const normalized: unknown = canonicalizeMetadata(html, sourceRoot);
        return string(normalized, "QRC canonicalizeMetadata result");
      },
      receipt: {
        manifest: resolve(manifestPath),
        repository: source.repository,
        sha: source.sha,
        path,
      },
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
