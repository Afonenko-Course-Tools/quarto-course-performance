import { isAbsolute, join, relative } from "node:path";
export async function hashBytes(data: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
export async function hashFile(path: string): Promise<string> {
  return await hashBytes(await Deno.readFile(path));
}
export async function files(
  root: string,
  options: { materializeFileLinks?: boolean; sourceSnapshot?: boolean } = {},
): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (
        options.sourceSnapshot &&
        relative(root, path).split(/[\\/]/).slice(-2).join("/") === ".quarto/course-perf"
      ) continue;
      if (entry.isSymlink) {
        if (!options.materializeFileLinks) {
          throw new Error(`Символическая ссылка запрещена: ${path}`);
        }
        await contained(root, path);
        if (!(await Deno.stat(path)).isFile) {
          throw new Error(`Ссылка runtime не указывает на файл: ${path}`);
        }
        result.push(path);
        continue;
      }
      if (entry.isDirectory) await visit(path);
      else if (entry.isFile) result.push(path);
      else throw new Error(`Специальный файл запрещён: ${path}`);
    }
  }
  await visit(root);
  return result.sort();
}
export async function treeHash(
  root: string,
  options: { sourceSnapshot?: boolean } = {},
): Promise<string> {
  const rows = [];
  for (const path of await files(root, options)) {
    const info = await Deno.stat(path);
    rows.push([relative(root, path), info.mode! & 0o777, await hashFile(path)]);
  }
  return await hashBytes(new TextEncoder().encode(JSON.stringify(rows)));
}
export async function copyTree(
  source: string,
  destination: string,
  options: { materializeFileLinks?: boolean; sourceSnapshot?: boolean } = {},
): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for (const path of await files(source, options)) {
    const target = join(destination, relative(source, path));
    const info = await Deno.stat(path);
    await Deno.mkdir(join(target, ".."), { recursive: true });
    await Deno.copyFile(path, target);
    if (info.mode !== null) await Deno.chmod(target, info.mode & 0o777);
    // Quarto использует input mtime в sitemap; время новой копии меняет output.
    if (info.mtime !== null) await Deno.utime(target, info.atime ?? info.mtime, info.mtime);
  }
}
export async function contained(root: string, path: string): Promise<void> {
  const canonical = await Deno.realPath(root);
  const target = await Deno.realPath(path);
  const rel = relative(canonical, target);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`Путь вне рабочей копии: ${path}`);
  }
}
