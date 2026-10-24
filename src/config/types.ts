import { isAbsolute } from "node:path";
import type { SimpleMode } from "../report/types.ts";

export type Mode = SimpleMode | "trace";
export type Variant = "upstream" | "clean-control" | "candidate";
export interface SourceRequest {
  repository: string;
  refPolicy: "remote-default-head" | "explicit-remote-ref";
  ref?: string;
}
export interface SourceReceipt {
  repository: string;
  sourceKind: "github-baseline" | "local-candidate";
  remoteRef: string;
  sha: string;
  baseSha?: string;
  fetchedAt: string;
  checkoutPath: string;
}
export interface PackageReceipt {
  repository: string;
  ownerSha: string;
  extensionId: string;
  sourcePath: string;
  packageHash: string;
  destinationPaths: string[];
}
export interface Replacement {
  repository: string;
  extensionId: string;
  destinations: string[];
}
export type OutputPolicy = "strict" | "java-pilot-core-qrc-v1";
export function validateSourceSelection(
  selection: {
    sources: { repository: string }[];
    projectSource: string;
    replacements: Replacement[];
  },
) {
  const repositories = selection.sources.map((s) => s.repository);
  if (
    repositories.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r)) ||
    new Set(repositories).size !== repositories.length ||
    !repositories.includes(selection.projectSource) || !Array.isArray(selection.replacements)
  ) throw new Error("Недопустимые projectSource/replacements");
  const destinations: string[] = [];
  for (const r of selection.replacements) {
    if (
      !r || !repositories.includes(r.repository) || !/^[\w.-]+$/.test(r.extensionId) ||
      [".", ".."].includes(r.extensionId) || !Array.isArray(r.destinations) ||
      !r.destinations.length
    ) throw new Error("Недопустимая замена пакета");
    for (const path of r.destinations) {
      if (
        typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") ||
        path.split("/").some((p) => !p || p === "." || p === "..") ||
        !path.split("/").includes("_extensions")
      ) throw new Error("Недопустимый destination пакета");
      if (
        destinations.some((p) => p === path || p.startsWith(path + "/") || path.startsWith(p + "/"))
      ) throw new Error("Неоднозначные destinations");
      destinations.push(path);
    }
  }
}
export interface SourceManifest {
  schema_version: 2;
  projectSource: string;
  replacements: Replacement[];
  experimentId: string;
  sources: SourceReceipt[];
  packages: PackageReceipt[];
  runtime: Record<string, { path: string; version: string; hash: string }>;
}
export interface PreparedVariant {
  variant: Variant;
  root: string;
  manifest: SourceManifest;
}
export interface Scenario {
  id: string;
  cwd: string;
  executable: string;
  args: string[];
  cachePolicy: "clean-output" | "repeat-render";
  mode: Mode;
  scope: { modules: string[]; extensions: string[]; strict: boolean };
  resources: { wall: boolean; cpu: boolean; peakRss: boolean };
}
export interface PreparationReceipt {
  kind: "bootstrap" | "ts-transform" | "quarto-adapter";
  path: string;
  sourceHash: string;
  preparedHash: string;
  sourceMapPath?: string;
}
export interface RunResult {
  runId: string;
  buildExitCode: number;
  dataValid: boolean;
  outputDirectory: string;
  preparation: PreparationReceipt[];
  wallSeconds: number;
  signal: string | null;
}

export interface RunPaths {
  runId: string;
  stagingDirectory: string;
  finalDirectory: string;
}

/** Только для чтения исторических отчётов; не вход prepare/freeze/run. */
export type HistoricalSourceManifest =
  & Omit<SourceManifest, "schema_version" | "projectSource" | "replacements">
  & { schema_version?: 1 };
export type ReportSourceManifest = SourceManifest | HistoricalSourceManifest;
export function importSourceManifest(value: unknown, historical = false): ReportSourceManifest {
  if (!value || typeof value !== "object") throw new Error("Некорректный source manifest");
  const manifest = value as SourceManifest;
  if (
    !Array.isArray(manifest.sources) || !Array.isArray(manifest.packages) || !manifest.runtime ||
    typeof manifest.experimentId !== "string"
  ) throw new Error("Некорректный source manifest");
  if (manifest.schema_version === 2) {
    validateSourceSelection(manifest);
    for (const source of manifest.sources) {
      if (
        !/^[0-9a-f]{40}$/.test(source.sha) ||
        !["github-baseline", "local-candidate"].includes(source.sourceKind) ||
        typeof source.checkoutPath !== "string" || !isAbsolute(source.checkoutPath) ||
        typeof source.remoteRef !== "string" || typeof source.fetchedAt !== "string" ||
        source.baseSha !== undefined && !/^[0-9a-f]{40}$/.test(source.baseSha)
      ) throw new Error("Некорректное происхождение source manifest v2");
    }
    for (const runtime of Object.values(manifest.runtime)) {
      if (
        !runtime || typeof runtime.path !== "string" || !isAbsolute(runtime.path) ||
        typeof runtime.version !== "string" || !/^[0-9a-f]{64}$/.test(runtime.hash)
      ) throw new Error("Некорректный runtime receipt");
    }
    return manifest;
  }
  if (
    historical && (manifest.schema_version === undefined || Number(manifest.schema_version) === 1)
  ) return value as HistoricalSourceManifest;
  throw new Error(
    "Необходим source manifest v2; исторический импорт доступен только report/verify",
  );
}
export function liveSourceManifest(value: unknown): SourceManifest {
  return importSourceManifest(value) as SourceManifest;
}
