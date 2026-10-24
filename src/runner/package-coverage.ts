import { basename, dirname, join, relative, resolve } from "node:path";
import { assetPath } from "../assets.ts";
import { files, hashFile } from "../sources/snapshot.ts";
import type { Event } from "../protocol/types.ts";

export interface PackageCoverage {
  scopeRoot: string | null;
  scope: "selected-project-tree";
  inventoryStatus: "recorded" | "partial" | "unknown";
  packages: {
    extensionId: string;
    path: string;
    installed: true;
    instrumentation: "detected" | "not-detected" | "unknown";
    instrumentationEvidence: { path: string; sha256: string; kind: string }[];
  }[] | null;
  requested: { extensionId: string; installed: boolean | null }[] | null;
  issues: string[];
  observationStatus: "pending" | "valid" | "partial";
  observations: {
    extensionId: string;
    attribution: "recorded" | "derived";
    processId: string;
    executorId: string;
    events: number;
  }[];
}

// Только лексические свидетельства, без Compiler API или исполнения исходников.
// Комментарии, примеры в строках/regex и Lua long strings не являются вызовами.
function tokens(source: string): string[] {
  return source.match(
    /--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*|\[(=*)\[[\s\S]*?\]\2\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/(?:\\.|[^\/\n\\])+\/[a-z]*|[\w$]+|[^\s]/g,
  )?.filter((token) =>
    !token.startsWith("--") && !token.startsWith("//") && !token.startsWith("/*")
  ) ?? [];
}
function literal(token: string | undefined): string | undefined {
  return token && /^["'][\w./-]+["']$/.test(token) ? token.slice(1, -1) : undefined;
}

export async function collectPackageCoverage(
  scopeRoot: string,
  requested: string[] = [],
  excluded: string[] = [],
): Promise<PackageCoverage> {
  scopeRoot = await Deno.realPath(scopeRoot);
  const coverage: PackageCoverage = {
    scopeRoot,
    scope: "selected-project-tree",
    inventoryStatus: "recorded",
    packages: [],
    requested: [],
    issues: [],
    observationStatus: "pending",
    observations: [],
  };
  const canonical = {
    ts: await hashFile(assetPath("bridge/bridge.ts")),
    lua: await hashFile(assetPath("bridge/bridge.lua")),
  };
  const skip = new Set([".git", ".quarto", "node_modules", "_site", "_book"]);
  const excludedPaths = new Set(excluded.map((path) => resolve(path)));
  const issue = (path: string, error: unknown) => {
    coverage.inventoryStatus = "partial";
    coverage.issues.push(`${relative(scopeRoot, path)}: ${error}`);
  };
  async function packageAt(path: string) {
    const pkg: NonNullable<PackageCoverage["packages"]>[number] = {
      extensionId: basename(path),
      path: relative(scopeRoot, path),
      installed: true,
      instrumentation: "not-detected",
      instrumentationEvidence: [],
    };
    coverage.packages!.push(pkg);
    try {
      for (const file of await files(path)) {
        const language = file.endsWith(".ts") ? "ts" : file.endsWith(".lua") ? "lua" : undefined;
        if (!language) continue;
        const words = tokens(await Deno.readTextFile(file));
        const aliases = new Set<string>();
        const facade = async (name: string | undefined) => {
          if (!name?.startsWith(".")) return false;
          const target = resolve(
            dirname(file),
            name + (language === "lua" && !name.endsWith(".lua") ? ".lua" : ""),
          );
          if (relative(path, target).split("/").includes("..")) return false;
          try {
            return await hashFile(target) === canonical[language];
          } catch {
            return false;
          }
        };
        if (language === "ts") {
          for (let i = 0; i < words.length; i++) {
            if (words[i] !== "import") continue;
            const end = words.indexOf("from", i + 1);
            if (end < 0 || words.slice(i, end).includes(";")) continue;
            if (!await facade(literal(words[end + 1]))) continue;
            for (let j = i + 1; j < end; j++) {
              if (words[j] === "createMetrics") {
                aliases.add(words[j + 1] === "as" ? words[j + 2] : words[j]);
              }
            }
          }
        }
        for (let i = 0; i < words.length - 2; i++) {
          if (
            !/(?:createMetrics|create_metrics)$/.test(words[i]) || words[i + 1] !== "(" ||
            words[i - 1] === "function"
          ) continue;
          const id = literal(words[i + 2]);
          if (!id) continue;
          const bound = language === "ts"
            ? aliases.has(words[i])
            : words[i - 1] === "." && words[i - 2] === ")" && words[i - 4] === "(" &&
              words[i - 5] === "require" && await facade(literal(words[i - 3]));
          const confirmed = bound && id === pkg.extensionId;
          pkg.instrumentationEvidence.push({
            path: relative(scopeRoot, file),
            sha256: await hashFile(file),
            kind: confirmed ? "canonical-abi1-binding" : "unresolved-metrics-call",
          });
          if (confirmed) pkg.instrumentation = "detected";
          else if (pkg.instrumentation !== "detected") pkg.instrumentation = "unknown";
        }
      }
    } catch (error) {
      pkg.instrumentation = "unknown";
      issue(path, error);
    }
  }
  async function walk(path: string, extensions = false) {
    try {
      if (extensions) {
        try {
          if ((await Deno.lstat(join(path, "_extension.yml"))).isFile) {
            await packageAt(path);
            return;
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
      const entries = [...Deno.readDirSync(path)].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (skip.has(entry.name) || excludedPaths.has(child)) continue;
        if (entry.isSymlink) {
          if (extensions || entry.name === "_extensions") issue(child, "symlink inventory unknown");
          continue;
        }
        if (entry.isDirectory) await walk(child, extensions || entry.name === "_extensions");
      }
    } catch (error) {
      issue(path, error);
    }
  }
  await walk(scopeRoot);
  coverage.packages!.sort((a, b) => a.path.localeCompare(b.path));
  coverage.requested = requested.map((extensionId) => ({
    extensionId,
    installed: coverage.packages!.some((p) => p.extensionId === extensionId)
      ? true
      : coverage.inventoryStatus === "recorded"
      ? false
      : null,
  }));
  return coverage;
}

export function observePackages(
  inventory: PackageCoverage | undefined,
  events: Event[],
  dataValid: boolean,
): PackageCoverage {
  const result: PackageCoverage = inventory ? { ...inventory } : {
    scopeRoot: null,
    scope: "selected-project-tree",
    inventoryStatus: "unknown",
    packages: null,
    requested: null,
    issues: [],
    observationStatus: "pending",
    observations: [],
  };
  const observations = new Map<string, PackageCoverage["observations"][number]>();
  for (const event of events) {
    const recorded = event.attributes?.extension_id;
    const extensionId = typeof recorded === "string" && recorded
      ? recorded
      : event.operation_id?.split(".")[0];
    if (!extensionId) continue;
    const attribution = typeof recorded === "string" && recorded ? "recorded" : "derived";
    const key = JSON.stringify([extensionId, attribution, event.process_id, event.executor_id]);
    const row = observations.get(key) ??
      {
        extensionId,
        attribution,
        processId: event.process_id,
        executorId: event.executor_id,
        events: 0,
      };
    row.events++;
    observations.set(key, row);
  }
  result.observations = [...observations.values()];
  result.observationStatus = dataValid ? "valid" : "partial";
  return result;
}
