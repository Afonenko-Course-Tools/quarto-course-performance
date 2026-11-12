import { isAbsolute } from "node:path";
import { array, object, oneOf, string, strings } from "../json.ts";
import type { SimpleMode } from "../report/types.ts";

export type Mode = SimpleMode | "trace";
export type Variant = "upstream" | "clean-control" | "candidate";

export interface SourceSelection {
  repository: string;
  sourceKind: "github-baseline" | "local-candidate";
  remoteRef: string;
  sha: string;
  baseSha?: string;
  fetchedAt: string;
  checkoutPath: string;
}
export interface InstalledPackage {
  repository: string;
  ownerSha: string;
  extensionId: string;
  sourcePath: string;
  destinationPaths: string[];
}

export type OutputPolicy = "strict" | "java-pilot-core-qrc-v1";
export function validateSourceSelection(selection: {
  sources: { repository: string }[];
  projectSource: string;
}) {
  const repositories = selection.sources.map((s) => s.repository);
  if (
    repositories.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r)) ||
    new Set(repositories).size !== repositories.length ||
    !repositories.includes(selection.projectSource)
  ) throw new Error("Недопустимый projectSource/sources");
}
export interface SourceManifest {
  schema_version: 2;
  projectSource: string;
  experimentId: string;
  sources: SourceSelection[];
  packages: InstalledPackage[];
  runtime: Record<string, { path: string; version: string }>;
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
export interface PreparedScript {
  kind: "bootstrap" | "ts-transform" | "quarto-adapter";
  path: string;
  sourceMapPath?: string;
}
export function validatePreparedScript(value: unknown): PreparedScript {
  const receipt = object(value, "preparedScripts");
  if (Object.keys(receipt).some((key) => !["kind", "path", "sourceMapPath"].includes(key))) {
    throw new Error("Удалённые proof поля preparedScripts не принимаются");
  }
  const { sourceMapPath, ...receiptFields } = receipt;
  return {
    ...receiptFields,
    kind: oneOf(receipt.kind, ["bootstrap", "ts-transform", "quarto-adapter"]),
    path: string(receipt.path),
    ...(sourceMapPath === undefined ? {} : { sourceMapPath: string(sourceMapPath) }),
  };
}
export interface RunResult {
  runId: string;
  buildExitCode: number;
  dataValid: boolean;
  outputDirectory: string;
  preparedScripts: PreparedScript[];
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
  & Omit<SourceManifest, "schema_version" | "projectSource">
  & { schema_version?: 1 };
export type ReportSourceManifest = SourceManifest | HistoricalSourceManifest;
export function importSourceManifest(value: unknown, historical = false): ReportSourceManifest {
  const input = object(value, "source manifest");
  if (!historical && "replacements" in input) {
    throw new Error("replacements удалены: заново выполните freeze готовых course checkout");
  }
  const { schema_version: schemaVersion, ...manifestFields } = input;
  const sources: SourceSelection[] = array(input.sources).map((value) => {
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
  const packages: InstalledPackage[] = array(input.packages).map((value) => {
    const pkg = object(value, "package receipt");
    if (!historical && "packageHash" in pkg) {
      throw new Error("Удалённые digest поля пакета не принимаются");
    }
    return {
      ...pkg,
      repository: string(pkg.repository),
      ownerSha: string(pkg.ownerSha),
      extensionId: string(pkg.extensionId),
      sourcePath: string(pkg.sourcePath),
      destinationPaths: strings(pkg.destinationPaths),
    };
  });
  const runtime: SourceManifest["runtime"] = Object.fromEntries(
    Object.entries(object(input.runtime)).map(([name, value]) => {
      const receipt = object(value, "runtime receipt");
      if (!historical && Object.keys(receipt).some((key) => !["path", "version"].includes(key))) {
        throw new Error("Удалённые digest поля runtime не принимаются");
      }
      return [name, {
        ...receipt,
        path: string(receipt.path),
        version: string(receipt.version),
      }];
    }),
  );
  const common = { sources, packages, runtime, experimentId: string(input.experimentId) };
  if (input.schema_version === 2) {
    const manifest: SourceManifest = {
      ...manifestFields,
      ...common,
      schema_version: 2,
      projectSource: string(input.projectSource),
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
      if (!isAbsolute(receipt.path)) {
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
