import { join } from "node:path";
import {
  liveSourceManifest,
  type PreparedVariant,
  type SourceManifest,
  type Variant,
} from "../config/types.ts";
import { git } from "./git.ts";
import { files } from "./files.ts";
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
  if (await git(["-C", course.checkoutPath, "rev-parse", "--show-prefix"])) {
    throw new Error("Нужен корень course checkout");
  }
  const root = join(workspace, variant);
  await Deno.mkdir(root, { recursive: false });
  const archive = new Deno.Command("git", {
    args: ["-C", course.checkoutPath, "archive", "--format=tar", course.sha],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const extract = new Deno.Command("tar", {
    args: ["-xf", "-", "-C", root],
    stdin: "piped",
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  await archive.stdout.pipeTo(extract.stdin);
  const [archived, extracted] = await Promise.all([archive.status, extract.status]);
  if (!archived.success || !extracted.success) throw new Error("Git archive / tar неуспешен");
  await files(root);
  return { variant, root, manifest };
}
