import { join } from "node:path";
import type { PreparedVariant, SourceManifest, Variant } from "../config/types.ts";
import { copyTree, hashFile } from "./snapshot.ts";
import { installPackages } from "./packages.ts";
import { git } from "./resolve.ts";
export async function verifySources(manifest: SourceManifest): Promise<void> {
  for (const [name, runtime] of Object.entries(manifest.runtime)) {
    if (await hashFile(runtime.path) !== runtime.hash) {
      throw new Error(`Runtime hash расходится: ${name}`);
    }
  }
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
  await verifySources(manifest);
  const course = manifest.sources.find((s) => s.repository.endsWith("/Java"));
  if (!course) throw new Error("Источник Java отсутствует");
  const root = join(workspace, variant);
  await Deno.mkdir(root, { recursive: false });
  await copyTree(course.checkoutPath, root);
  const packages = await installPackages(root, manifest.sources.filter((s) => s !== course));
  return { variant, root, manifest: { ...manifest, packages } };
}
