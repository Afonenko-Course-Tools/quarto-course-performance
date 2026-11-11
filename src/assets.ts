import { parseObject, string } from "./json.ts";
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
    "--cached-only",
    "-A",
  ];
}

/** Версия CLI и новых отчётов принадлежит config установленного приложения. */
export async function toolVersion(): Promise<string> {
  return string(parseObject(await Deno.readTextFile(assetPath("deno.json"))).version, "version");
}
