import { join } from "node:path";
import type { SourceManifest, Variant, PreparedVariant } from "../config/types.ts";
import { copyTree } from "./snapshot.ts";
import { installPackages } from "./packages.ts";
export async function prepareVariant(manifest: SourceManifest, variant: Variant, workspace: string): Promise<PreparedVariant> {
  const course=manifest.sources.find(s=>s.repository.endsWith("/Java"));
  if(!course) throw new Error("Источник Java отсутствует");
  const root=join(workspace,variant); await Deno.mkdir(root,{recursive:false}); await copyTree(course.checkoutPath,root);
  const packages=await installPackages(root,manifest.sources.filter(s=>s!==course));
  return {variant,root,manifest:{...manifest,packages}};
}
