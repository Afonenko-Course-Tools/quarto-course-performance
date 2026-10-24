import { isAbsolute, join, relative, resolve } from "node:path";
import type { PackageReceipt, Replacement } from "../config/types.ts";
import { contained, copyTree, files, treeHash } from "./snapshot.ts";
export async function installPackages(
  root: string,
  owners: { repository: string; sha: string; checkoutPath: string }[],
  replacements: Replacement[],
): Promise<PackageReceipt[]> {
  const receipts: PackageReceipt[] = [], actions: { source: string; dest: string }[] = [];
  // Все пути и содержимое проверяются до первого удаления установленного пакета.
  async function auditPath(base: string, path: string) {
    const rel = relative(resolve(base), resolve(path));
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
      throw new Error(`Путь вне рабочей копии: ${path}`);
    }
    let current = resolve(base);
    if ((await Deno.lstat(current)).isSymlink) {
      throw new Error(`Символическая ссылка запрещена: ${current}`);
    }
    for (const part of rel.split("/").filter(Boolean)) {
      current = join(current, part);
      if ((await Deno.lstat(current)).isSymlink) {
        throw new Error(`Символическая ссылка запрещена: ${current}`);
      }
    }
    await contained(base, path);
  }
  for (const mapping of replacements) {
    const owner = owners.find((o) => o.repository === mapping.repository);
    if (
      !owner || owners.filter((o) => o.repository === mapping.repository).length !== 1 ||
      !/^[\w.-]+$/.test(mapping.extensionId) || [".", ".."].includes(mapping.extensionId) ||
      !mapping.destinations.length
    ) throw new Error("Неоднозначный владелец или пакет");
    const source = join(owner.checkoutPath, "_extensions", mapping.extensionId);
    await auditPath(owner.checkoutPath, source);
    await Deno.stat(join(source, "_extension.yml"));
    await files(source, { sourceSnapshot: true });
    const destinations: string[] = [];
    for (const destination of mapping.destinations) {
      if (
        !destination || isAbsolute(destination) || destination.includes("\\") ||
        destination.split("/").some((p) => !p || p === "." || p === "..")
      ) throw new Error("Недопустимый destination");
      const dest = resolve(root, destination), rel = relative(resolve(root), dest).split("/");
      if (rel.length < 2 || !rel.includes("_extensions") || !rel.at(-1)) {
        throw new Error("Destination должен указывать на установленный пакет _extensions");
      }
      await auditPath(root, dest);
      await Deno.stat(join(dest, "_extension.yml"));
      await files(dest);
      if (
        actions.some((a) =>
          a.dest === dest || a.dest.startsWith(dest + "/") || dest.startsWith(a.dest + "/")
        )
      ) throw new Error("Неоднозначные destinations");
      actions.push({ source, dest });
      destinations.push(dest);
    }
    receipts.push({
      repository: owner.repository,
      ownerSha: owner.sha,
      extensionId: mapping.extensionId,
      sourcePath: source,
      packageHash: await treeHash(source, { sourceSnapshot: true }),
      destinationPaths: destinations,
    });
  }
  for (const action of actions) {
    await Deno.remove(action.dest, { recursive: true });
    await copyTree(action.source, action.dest, { sourceSnapshot: true });
  }
  return receipts;
}
