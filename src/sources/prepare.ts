import { join } from "node:path";
import {
  liveSourceManifest,
  type PreparedVariant,
  type SourceManifest,
  type Variant,
} from "../config/types.ts";
import { copyTree } from "./files.ts";
import { installPackages } from "./packages.ts";
import { git } from "./resolve.ts";
export async function verifySources(manifest: SourceManifest): Promise<void> {
  for (const source of manifest.sources) {
    if (await git(["-C", source.checkoutPath, "rev-parse", "HEAD"]) !== source.sha) {
      throw new Error(`Checkout SHA расходится: ${source.repository}`);
    }
    if (await git(["-C", source.checkoutPath, "status", "--porcelain"])) {
      throw new Error(`Checkout изменён (dirty): ${source.repository}`);
    }
  }
}
export async function prepareVariant(
  manifest: SourceManifest,
  variant: Variant,
  workspace: string,
): Promise<PreparedVariant> {
  manifest = liveSourceManifest(manifest);
  await verifySources(manifest);
  const course = manifest.sources.find((s) => s.repository === manifest.projectSource);
  if (!course) throw new Error("Источник projectSource отсутствует");
  const root = join(workspace, variant);
  await Deno.mkdir(root, { recursive: false });
  await copyTree(course.checkoutPath, root, { workingCopy: true });
  const packages = await installPackages(root, manifest.sources, manifest.replacements);
  return { variant, root, manifest: { ...manifest, packages } };
}
