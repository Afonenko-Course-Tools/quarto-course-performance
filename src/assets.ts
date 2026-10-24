import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Файлы приложения разрешаются независимо от cwd и URL-кодирования. */
export function assetPath(relative: string): string {
  return resolve(fileURLToPath(new URL("../", import.meta.url)), relative);
}

/** Только собственные entrypoints; параметры Deno самого курса сохраняет launcher. */
export function appDenoArgs(root = assetPath(".")): string[] {
  return [
    "run",
    "--config",
    resolve(root, "deno.json"),
    "--lock",
    resolve(root, "deno.lock"),
    "--frozen",
    "--node-modules-dir=manual",
    "--cached-only",
    "-A",
  ];
}
