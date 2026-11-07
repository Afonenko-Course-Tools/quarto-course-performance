import { array, object, oneOf, string, strings } from "../json.ts";
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
export function validatePreparationReceipt(value: unknown): PreparationReceipt {
  const receipt = object(value, "preparation");
  const { sourceMapPath, ...receiptFields } = receipt;
  return {
    ...receiptFields,
    kind: oneOf(receipt.kind, ["bootstrap", "ts-transform", "quarto-adapter"]),
    path: string(receipt.path),
    sourceHash: string(receipt.sourceHash),
    preparedHash: string(receipt.preparedHash),
    ...(sourceMapPath === undefined ? {} : { sourceMapPath: string(sourceMapPath) }),
  };
}
export interface RunResult {
  runId: string;
  buildExitCode: number;
  dataValid: boolean;
  outputDirectory: string;
  preparation: PreparationReceipt[];
  wallSeconds: number;
  signal: Deno.Signal | null;
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
  const input = object(value, "source manifest");
  const { schema_version: schemaVersion, ...manifestFields } = input;
  const sources: SourceReceipt[] = array(input.sources).map((value) => {
    const source = object(value, "source receipt");
    const { baseSha, ...sourceFields } = source;
    return {
      ...sourceFields,
      repository: string(source.repository),
      sourceKind: oneOf(source.sourceKind, ["github-baseline", "local-candidate"]),
      remoteRef: string(source.remoteRef),
      sha: string(source.sha),
      fetchedAt: string(source.fetchedAt),
      checkoutPath: string(source.checkoutPath),
      ...(baseSha === undefined ? {} : { baseSha: string(baseSha) }),
    };
  });
  const packages: PackageReceipt[] = array(input.packages).map((value) => {
    const pkg = object(value, "package receipt");
    return {
      ...pkg,
      repository: string(pkg.repository),
      ownerSha: string(pkg.ownerSha),
      extensionId: string(pkg.extensionId),
      sourcePath: string(pkg.sourcePath),
      packageHash: string(pkg.packageHash),
      destinationPaths: strings(pkg.destinationPaths),
    };
  });
  const runtime: SourceManifest["runtime"] = Object.fromEntries(
    Object.entries(object(input.runtime)).map(([name, value]) => {
      const receipt = object(value, "runtime receipt");
      return [name, {
        ...receipt,
        path: string(receipt.path),
        version: string(receipt.version),
        hash: string(receipt.hash),
      }];
    }),
  );
  const common = { sources, packages, runtime, experimentId: string(input.experimentId) };
  if (input.schema_version === 2) {
    const replacements: Replacement[] = array(input.replacements).map((value) => {
      const replacement = object(value, "replacement");
      return {
        ...replacement,
        repository: string(replacement.repository),
        extensionId: string(replacement.extensionId),
        destinations: strings(replacement.destinations),
      };
    });
    const manifest: SourceManifest = {
      ...manifestFields,
      ...common,
      schema_version: 2,
      projectSource: string(input.projectSource),
      replacements,
    };
    validateSourceSelection(manifest);
    for (const source of sources) {
      if (
        !/^[0-9a-f]{40}$/.test(source.sha) || !isAbsolute(source.checkoutPath) ||
        source.baseSha !== undefined && !/^[0-9a-f]{40}$/.test(source.baseSha)
      ) {
        throw new Error("Некорректное происхождение source manifest v2");
      }
    }
    for (const receipt of Object.values(runtime)) {
      if (!isAbsolute(receipt.path) || !/^[0-9a-f]{64}$/.test(receipt.hash)) {
        throw new Error("Некорректный runtime receipt");
      }
    }
    return manifest;
  }
  if (historical && (schemaVersion === undefined || Number(schemaVersion) === 1)) {
    return {
      ...manifestFields,
      ...common,
      ...(schemaVersion === undefined ? {} : { schema_version: 1 }),
    };
  }
  throw new Error(
    "Необходим source manifest v2; исторический импорт доступен только report/verify",
  );
}
export function liveSourceManifest(value: unknown): SourceManifest {
  const manifest = importSourceManifest(value);
  if (manifest.schema_version !== 2) throw new Error("Необходим source manifest v2");
  return manifest;
}
