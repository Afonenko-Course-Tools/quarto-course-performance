import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { importSourceManifest, type ReportSourceManifest } from "../config/types.ts";
import { hashFile } from "../sources/snapshot.ts";
import { type NormalizedRun, normalizeRun } from "./normalize.ts";
import { type RunRecord, validateRunRecord } from "../report/types.ts";
import { writeRunArtifacts } from "../report/run.ts";

const adapterVersion = "experiment-history-v1";
interface Receipt {
  path: string;
  sha256: string;
  schemaVersion: number | null;
}
async function metadata(path: string) {
  const value = JSON.parse(await Deno.readTextFile(path));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Некорректные исторические metadata: ${path}`);
  }
  if (
    value.schema_version !== undefined && value.schema_version !== 1 && value.schema_version !== 2
  ) {
    throw new Error(`Неизвестная schema исторических metadata: ${path}`);
  }
  const receipt: Receipt = {
    path: await Deno.realPath(path),
    sha256: await hashFile(path),
    schemaVersion: value.schema_version ?? null,
  };
  return { value, receipt };
}
async function physical(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    // A dangling symlink is not a missing directory.
    try {
      await Deno.lstat(path);
      throw new Error(`Недопустимый output: ${path}`);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    return join(await physical(dirname(path)), basename(path));
  }
}
function within(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
async function destination(source: string, output: string): Promise<string> {
  if (typeof output !== "string" || !output.trim()) {
    throw new Error("Необходим явный --output для исторического импорта");
  }
  const target = await physical(resolve(output));
  if (within(source, target) || within(target, source)) {
    throw new Error("Исторический source и output пересекаются");
  }
  try {
    const stat = await Deno.lstat(target);
    if (!stat.isDirectory || stat.isSymlink) throw new Error("Output должен быть свежим каталогом");
    for await (const _ of Deno.readDir(target)) {
      throw new Error("Output должен быть пустым каталогом");
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return target;
}
// Read-only preflight enumerates exactly the files to copy; links and special files
// in consumed material are refused rather than followed into another workspace.
async function materialFiles(path: string): Promise<string[]> {
  const stat = await Deno.lstat(path);
  if (stat.isSymlink || !stat.isFile && !stat.isDirectory) {
    throw new Error(`Недопустимый исторический материал: ${path}`);
  }
  if (stat.isFile) return [path];
  const result: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    result.push(...await materialFiles(join(path, entry.name)));
  }
  return result.sort();
}
async function optionalFiles(path: string): Promise<string[]> {
  try {
    return await materialFiles(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
}
async function copy(source: string, target: string) {
  await Deno.mkdir(dirname(target), { recursive: true });
  await Deno.copyFile(source, target);
}
function legacyRecord(
  value: Record<string, unknown>,
  manifest: ReportSourceManifest,
  source: string,
  output: string,
  run: NormalizedRun,
): RunRecord {
  if (value.schema_version === 2) {
    return {
      ...validateRunRecord(value),
      collectionDirectory: source,
      outputDirectory: output,
      artifacts: {},
      dataValid: run.dataValid,
      quality: run.quality,
    };
  }
  // argv is the original producer's executable + full command; other commands
  // cannot be represented as a NativeRenderRequest without guessing semantics.
  const argv = value.argv;
  if (
    !Array.isArray(argv) || argv.some((a) => typeof a !== "string") || !argv[0] ||
    argv[1] !== "render" ||
    (!["quarto", "quarto.exe"].includes(basename(argv[0])) &&
      argv[0] !== manifest.runtime.quarto?.path)
  ) {
    throw new Error(`Исторический run требует сохранённый argv команды render: ${source}`);
  }
  if (
    typeof value.cwd !== "string" || !isAbsolute(value.cwd) || value.signal === undefined ||
    !Array.isArray(value.preparation)
  ) {
    throw new Error(`Исторический run не содержит обязательные cwd/signal/preparation: ${source}`);
  }
  const resources = value.resources as Record<string, unknown> | undefined;
  return validateRunRecord({
    schema_version: 2,
    runId: value.runId,
    request: { cwd: value.cwd, quarto: argv[0], nativeArgv: argv.slice(2), mode: value.mode },
    outcome: {
      code: value.buildExitCode,
      signal: value.signal,
      wallSeconds: value.wallSeconds,
      cpuUserSeconds: resources?.cpu_user_seconds ?? null,
      cpuSystemSeconds: resources?.cpu_system_seconds ?? null,
      peakRssKiB: resources?.peak_rss_kib ?? null,
    },
    preparation: value.preparation,
    dataValid: run.dataValid,
    quality: run.quality,
    versions: {
      tool: "unknown",
      quarto: manifest.runtime.quarto?.version ?? "unknown",
      deno: manifest.runtime.deno?.version ?? null,
      pandoc: manifest.runtime.pandoc?.version ?? null,
    },
    git: null,
    collectionDirectory: source,
    outputDirectory: output,
    artifacts: {},
    scenario: value.scenario ?? null,
    variant: value.variant ?? null,
    mode: value.mode,
    buildExitCode: value.buildExitCode,
    wallSeconds: value.wallSeconds,
    experimentId: manifest.experimentId,
  });
}

/** Explicit offline adapter. Required metadata and destination checks precede writes. */
export async function prepareHistoricalImport(
  sourcePath: string,
  outputPath: string,
  experimentId?: string,
) {
  const source = await Deno.realPath(sourcePath);
  const output = await destination(source, outputPath);
  await materialFiles(join(source, "candidate.manifest.json"));
  const originalManifest = await metadata(join(source, "candidate.manifest.json"));
  const manifest = importSourceManifest(originalManifest.value, true);
  if (experimentId && experimentId !== manifest.experimentId) {
    throw new Error("Неверный experiment id");
  }
  if (
    !manifest.experimentId ||
    manifest.sources.some((s) =>
      !s || typeof s.repository !== "string" || typeof s.remoteRef !== "string" ||
      typeof s.sha !== "string"
    )
  ) {
    throw new Error("Некорректное происхождение исторического manifest");
  }
  const plans: {
    files: string[];
    source: string;
    output: string;
    record: RunRecord;
    run: NormalizedRun;
    receipt: Receipt;
  }[] = [];
  const runRoot = join(source, "runs");
  if ((await Deno.lstat(runRoot)).isSymlink) throw new Error("Недопустимая ссылка runs");
  for await (const entry of Deno.readDir(runRoot)) {
    if (!entry.isDirectory || entry.isSymlink) {
      throw new Error(`Недопустимый материал runs: ${entry.name}`);
    }
    const dir = join(runRoot, entry.name);
    const files = await materialFiles(dir);
    const original = await metadata(join(dir, "run.json"));
    const value = original.value;
    const runManifestPath = join(dir, "manifest.json");
    const runManifest = files.includes(runManifestPath)
      ? await metadata(runManifestPath)
      : undefined;
    const runSources = runManifest ? importSourceManifest(runManifest.value, true) : manifest;
    if (runSources.experimentId !== manifest.experimentId) {
      throw new Error(`Несогласованный experimentId manifest: ${dir}`);
    }
    if (
      value.runId !== entry.name || !/^[\w.-]+$/.test(entry.name) ||
      [".", ".."].includes(entry.name)
    ) throw new Error(`Несогласованный runId: ${dir}`);
    if (value.experimentId !== undefined && value.experimentId !== manifest.experimentId) {
      throw new Error(`Несогласованный experimentId: ${dir}`);
    }
    const mode = value.schema_version === 2 ? value.request?.mode : value.mode;
    const run: NormalizedRun = mode === "off"
      ? {
        runId: value.runId,
        experimentId: manifest.experimentId,
        events: [],
        executors: {},
        dataValid: value.dataValid === true,
        quality: {
          droppedEvents: 0,
          incompleteSpans: 0,
          coverageComplete: false,
          errors: value.dataValid === true
            ? []
            : ["Исторический off run не подтверждает dataValid"],
        },
      }
      : await normalizeRun(dir, {
        readOnly: true,
        identity: { runId: value.runId, experimentId: manifest.experimentId },
      });
    if (value.dataValid !== true) {
      run.quality.errors.push("Исходные metadata не подтверждают dataValid");
      run.dataValid = false;
      run.quality.coverageComplete = false;
    }
    const target = join(output, "runs", entry.name);
    const record = legacyRecord(value, runSources, dir, target, run);
    record.importProvenance = {
      schema_version: 1,
      adapterVersion,
      sourceDirectory: source,
      manifest: originalManifest.receipt,
      run: original.receipt,
      ...(runManifest ? { runManifest: runManifest.receipt } : {}),
      sourceStatus: {
        buildExitCode: value.schema_version === 2 ? value.outcome.code : value.buildExitCode,
        dataValid: typeof value.dataValid === "boolean" ? value.dataValid : null,
        signalAvailability: value.signalAvailability ?? "unknown",
      },
    };
    plans.push({ source: dir, output: target, files, record, run, receipt: original.receipt });
  }
  if (!plans.length) throw new Error("Исторический workspace не содержит запусков");
  const benchmarkFiles = await optionalFiles(join(source, "benchmarks"));
  // Parse consumed benchmark JSON before creating the destination.
  for (const path of benchmarkFiles.filter((p) => p.endsWith(".json"))) {
    const benchmark = JSON.parse(await Deno.readTextFile(path));
    const c = benchmark?.comparison;
    if (
      benchmark?.complete === true && (!c || !Number.isSafeInteger(c.pairs) || c.pairs < 1 ||
        !Number.isFinite(c.medianRatio) || !Array.isArray(c.interval95) ||
        c.interval95.length !== 2 ||
        c.interval95.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n)) ||
        c.maxSlowdownRatio !== undefined && !Number.isFinite(c.maxSlowdownRatio))
    ) {
      throw new Error(`Некорректный сохранённый benchmark: ${path}`);
    }
  }
  const originalReports = (await Promise.all(
    [
      "report.md",
      "summary.json",
      "manifest.json",
      "coverage.json",
      "quality.json",
      "builds.json",
      "benchmarks.json",
    ].map((name) => optionalFiles(join(source, name))),
  )).flat();
  const provenance = {
    schema_version: 1,
    adapterVersion,
    sourceDirectory: source,
    manifest: originalManifest.receipt,
    runs: plans.map((p) => ({
      ...p.receipt,
      sourceStatus: p.record.importProvenance!.sourceStatus,
      ...(p.record.importProvenance!.runManifest
        ? { runManifest: p.record.importProvenance!.runManifest }
        : {}),
    })),
  };
  // Recheck freshness immediately before materialization. No source writer is used.
  await destination(source, output);
  await Deno.mkdir(output, { recursive: true });
  await copy(originalManifest.receipt.path, join(output, "historical/candidate.manifest.json"));
  for (const path of originalReports) {
    await copy(path, join(output, "historical", relative(source, path)));
  }
  for (const path of benchmarkFiles) await copy(path, join(output, relative(source, path)));
  const derivedNames = new Set([
    "run.json",
    "summary.json",
    "report.md",
    "wall.trace.json",
    "lua-cpu.trace.json",
    "causal.json",
  ]);
  for (const plan of plans) {
    await Deno.mkdir(plan.output, { recursive: true });
    for (const path of plan.files) {
      const rel = relative(plan.source, path);
      const target = derivedNames.has(rel)
        ? join(output, "historical/runs", plan.run.runId, rel)
        : join(plan.output, rel);
      await copy(path, target);
    }
    await writeRunArtifacts(plan.output, plan.record, plan.run);
  }
  await Deno.writeTextFile(
    join(output, "import-provenance.json"),
    JSON.stringify(provenance, null, 2) + "\n",
  );
  return {
    manifest,
    output,
    provenance,
    runs: plans.map((p) => p.run),
    nativeFailed: plans.some((p) =>
      p.record.outcome.code !== 0 || p.record.outcome.signal !== null
    ),
  };
}
