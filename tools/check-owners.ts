import { join, relative } from "node:path";
import { files } from "../src/sources/snapshot.ts";
import { syncBridge } from "./sync-bridge.ts";
const roots = Deno.args;
if (!roots.length) throw new Error("Укажите checkouts владельцев");
await syncBridge(roots, true);
const extensions = new Map<string, string>();
for (const root of roots) {
  for await (const ext of Deno.readDir(join(root, "_extensions"))) {
    if (ext.isDirectory) {
      const path = join(root, "_extensions", ext.name);
      if (extensions.has(ext.name)) throw new Error("Повтор owner extension");
      extensions.set(ext.name, path);
      const observation = await files(join(path, "observability"));
      if (
        observation.length !== 2 ||
        observation.some((p) =>
          !/^bridge\.(ts|lua)$/.test(relative(join(path, "observability"), p))
        )
      ) throw new Error("Пакет содержит лишние observability зависимости");
      for (const file of await files(path)) {
        if (
          (file.endsWith(".ts") || file.endsWith(".lua")) && !file.includes("/vendor/") &&
          /COURSE_BUILD_TRACE|performance\.now\s*\(/.test(await Deno.readTextFile(file))
        ) throw new Error("Legacy telemetry: " + file);
      }
    }
  }
}
const registry = JSON.parse(
  await Deno.readTextFile(new URL("../docs/operation-registry.json", import.meta.url)),
) as { extension: string; path: string; operation: string }[];
const ids = new Set<string>();
for (const entry of registry) {
  if (ids.has(entry.operation)) throw new Error("Повтор operation: " + entry.operation);
  ids.add(entry.operation);
  const root = extensions.get(entry.extension);
  if (!root) throw new Error("Отсутствует owner: " + entry.extension);
  if (!entry.path || entry.path.split(/[\\/]/).includes("..")) {
    throw new Error("Недопустимый registry path");
  }
  const source = await Deno.readTextFile(join(root, entry.path));
  if (!source.includes(entry.operation.replace(/\*$/, ""))) {
    throw new Error("Registry drift: " + entry.operation);
  }
}
console.log(
  `PASS ABI 1, self-contained observability, legacy removal и ${registry.length} зарегистрированных операций в ${extensions.size} пакетах`,
);
