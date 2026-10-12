import { basename, dirname, join, relative } from "node:path";
import type { PackageReceipt } from "../config/types.ts";
import { contained, copyTree, files, treeHash } from "./snapshot.ts";
export async function installPackages(
  root: string,
  owners: { repository: string; sha: string; checkoutPath: string }[],
): Promise<PackageReceipt[]> {
  // Entire destination is audited before any replacement, including symlinks.
  const descriptors = (await files(root)).filter((p) =>
    basename(p) === "_extension.yml" && relative(root, p).split("/").includes("_extensions")
  );
  const receipts: PackageReceipt[] = [];
  const actions: { source: string; dest: string }[] = [];
  for (const owner of owners) {
    const ext = join(owner.checkoutPath, "_extensions");
    for await (const entry of Deno.readDir(ext)) {
      if (!entry.isDirectory || entry.isSymlink) {
        throw new Error(`Недопустимый пакет ${entry.name}`);
      }
      const source = join(ext, entry.name),
        destinations = descriptors.filter((p) => basename(dirname(p)) === entry.name).map(dirname);
      if (!destinations.length) continue;
      for (const dest of destinations) {
        await contained(root, dest);
        actions.push({ source, dest });
      }
      receipts.push({
        repository: owner.repository,
        ownerSha: owner.sha,
        extensionId: entry.name,
        sourcePath: source,
        packageHash: await treeHash(source),
        destinationPaths: destinations,
      });
    }
  }
  for (const dest of descriptors.map(dirname)) {
    if (!actions.some((a) => a.dest === dest)) {
      throw new Error(`Неизвестный владелец установленного пакета: ${dest}`);
    }
  }
  for (const action of actions) {
    await Deno.remove(action.dest, { recursive: true });
    await copyTree(action.source, action.dest);
  }
  return receipts;
}
