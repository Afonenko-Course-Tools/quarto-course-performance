import { join, relative, resolve } from "node:path";
import type {
  BuildOutcome,
  GitProvenance,
  NativeRenderRequest,
  RunRecord,
} from "../report/types.ts";
import { OwnedProcessError, runOwnedProcess } from "./process.ts";
import { resolveRenderProject } from "../adapters/quarto/inspect.ts";
import { finalizeRun, prepareRunStorage } from "./storage.ts";
import { prepareRenderDiagnostic } from "./diagnostic.ts";
import { type NormalizedRun, normalizeRun } from "../analysis/normalize.ts";
import { jsonFiles } from "../report/run.ts";
import type { PreparationReceipt } from "../config/types.ts";
import { validateTelemetryEnvironment } from "./environment.ts";

export async function runNativeRender(
  request: NativeRenderRequest,
  stagingDirectory: string,
  diagnosticEnv: Record<string, string> = {},
): Promise<BuildOutcome> {
  return await runOwnedProcess({
    executable: request.quarto,
    args: ["render", ...request.nativeArgv],
    cwd: request.cwd,
    env: { ...Deno.env.toObject(), ...diagnosticEnv },
    stdoutPath: join(stagingDirectory, "stdout.log"),
    stderrPath: join(stagingDirectory, "stderr.log"),
  });
}

async function gitProvenance(cwd: string, outputParent?: string): Promise<GitProvenance | null> {
  const run = async (args: string[]) =>
    await new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" }).output();
  try {
    const root = await run(["rev-parse", "--show-toplevel"]);
    if (!root.success) return null;
    const gitRoot = new TextDecoder().decode(root.stdout).trim();
    const exclusions = [":(exclude,glob)**/.quarto/**"];
    if (outputParent !== undefined) {
      const parent = resolve(cwd, outputParent);
      try {
        for await (const entry of Deno.readDir(parent)) {
          if (!entry.isDirectory || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
          const directory = join(parent, entry.name), rel = relative(gitRoot, directory);
          if (rel === ".." || rel.startsWith("../")) continue;
          try {
            const previous = JSON.parse(await Deno.readTextFile(join(directory, "run.json")));
            if (
              previous.schema_version === 2 && previous.runId === entry.name &&
              previous.outputDirectory === directory
            ) exclusions.push(`:(exclude,top,literal)${rel}`);
          } catch (e) {
            if (!(e instanceof Deno.errors.NotFound) && !(e instanceof SyntaxError)) throw e;
          }
        }
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound) && !(e instanceof Deno.errors.NotADirectory)) {
          throw e;
        }
      }
    }
    const [head, status] = await Promise.all([
      run(["rev-parse", "HEAD"]),
      run(["status", "--porcelain", "--untracked-files=normal", "--", ".", ...exclusions]),
    ]);
    if (!status.success) throw new Error("Не удалось прочитать состояние Git");
    const decode = (data: Uint8Array) => new TextDecoder().decode(data).trim();
    return {
      root: decode(root.stdout),
      head: head.success ? decode(head.stdout) : null,
      dirty: decode(status.stdout).length > 0,
    };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}
function diagnostic(message: string): unknown | undefined {
  try {
    console.error(message);
  } catch (error) {
    return error;
  }
}
export async function renderCommand(request: NativeRenderRequest): Promise<number> {
  const conflicts = validateTelemetryEnvironment(Deno.env.toObject());
  if (conflicts.length) throw new Error(`Конфликт окружения измерений: ${conflicts.join(", ")}`);
  const target = await resolveRenderProject(request);
  // Git относится к исходникам выбранного проекта; native .quarto — служебная история.
  // Provenance читается до создания каталога результата и внешнего staging.
  const git = await gitProvenance(
    target.projectRoot,
    request.outputParent === undefined ? undefined : resolve(request.cwd, request.outputParent),
  );
  const version = await new Deno.Command(request.quarto, {
    args: ["--version"],
    cwd: request.cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!version.success) throw new Error("Не удалось определить версию Quarto");
  const paths = await prepareRunStorage(request, target);
  const prepared = request.mode === "off"
    ? undefined
    : await prepareRenderDiagnostic(request, target, join(paths.stagingDirectory, "diagnostic"));
  const diagnosticEnv: Record<string, string> = prepared
    ? {
      ...prepared.env,
      COURSE_PERF_MODE: request.mode,
      COURSE_PERF_RUN_ID: paths.runId,
      COURSE_PERF_EXPERIMENT_ID: paths.runId,
      COURSE_PERF_OUTPUT_DIR: paths.stagingDirectory,
    }
    : {};
  if (prepared) {
    await Deno.writeTextFile(
      join(paths.stagingDirectory, "expectations.json"),
      JSON.stringify({ schema_version: 2, processes: [] }),
    );
    await Deno.writeTextFile(
      join(paths.stagingDirectory, "coverage.json"),
      JSON.stringify(prepared.coverage, null, 2) + "\n",
    );
    await Deno.writeTextFile(
      join(paths.stagingDirectory, "mode.json"),
      JSON.stringify({ mode: request.mode, runId: paths.runId, experimentId: paths.runId }),
    );
  }
  let externalSignal: Deno.Signal | null = null;
  const rememberInt = () => {
    externalSignal ??= "SIGINT";
  };
  const rememberTerm = () => {
    externalSignal ??= "SIGTERM";
  };
  Deno.addSignalListener("SIGINT", rememberInt);
  Deno.addSignalListener("SIGTERM", rememberTerm);
  let outcome: BuildOutcome | undefined, failure: unknown;
  let diagnosticValid = true;
  let savedDirectory = paths.stagingDirectory;
  try {
    try {
      outcome = await runNativeRender(request, paths.stagingDirectory, diagnosticEnv);
    } catch (error) {
      failure = error;
      if (error instanceof OwnedProcessError) outcome = error.outcome;
    }
    if (outcome) {
      const errors = failure ? [failure instanceof Error ? failure.message : String(failure)] : [];
      let normalized: NormalizedRun | undefined;
      const preparation = [...prepared?.preparation ?? []];
      if (prepared) {
        try {
          normalized = await normalizeRun(paths.stagingDirectory);
          preparation.push(
            ...await jsonFiles(
              join(paths.stagingDirectory, "preparation"),
              ".json",
            ) as unknown as PreparationReceipt[],
          );
        } catch (error) {
          failure ??= error;
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      diagnosticValid = !failure && (normalized?.dataValid ?? !prepared);
      const record: RunRecord = {
        schema_version: 2,
        runId: paths.runId,
        request,
        outcome,
        preparation,
        dataValid: diagnosticValid,
        quality: normalized
          ? {
            ...normalized.quality,
            coverageComplete: false,
            errors: [...normalized.quality.errors, ...errors],
          }
          : { droppedEvents: 0, incompleteSpans: 0, coverageComplete: false, errors },
        versions: {
          tool: "2.0.0",
          quarto: new TextDecoder().decode(version.stdout).trim(),
          deno: prepared?.coverage.runtime.runtime.deno?.version ?? null,
          pandoc: prepared?.coverage.runtime.runtime.pandoc?.version ?? null,
        },
        git,
        collectionDirectory: paths.stagingDirectory,
        outputDirectory: paths.finalDirectory,
        artifacts: {},
      };
      try {
        savedDirectory = await finalizeRun(paths, record, normalized);
        const printError = diagnostic(`Отчёт Performance: ${savedDirectory}`);
        failure ??= printError;
      } catch (error) {
        failure ??= error;
        diagnostic(error instanceof Error ? error.message : String(error));
      }
      if (failure) {
        diagnostic(failure instanceof Error ? failure.message : String(failure));
        // Даже отказ stderr не должен заменить известный child exit/signal.
        try {
          const directory = await Deno.lstat(savedDirectory);
          if (!directory.isDirectory || directory.isSymlink) {
            throw new Error("Недопустимый каталог диагностики");
          }
          const receipt = await Deno.open(join(savedDirectory, "performance-error.json"), {
            write: true,
            createNew: true,
          });
          try {
            const data = new TextEncoder().encode(
              JSON.stringify(
                {
                  schema_version: 2,
                  error: failure instanceof Error ? failure.message : String(failure),
                },
                null,
                2,
              ) + "\n",
            );
            let offset = 0;
            while (offset < data.length) offset += await receipt.write(data.subarray(offset));
          } finally {
            receipt.close();
          }
        } catch { /* Доступные raw/report уже сохранены; исходный результат приоритетен. */ }
      }
    } else {
      diagnostic(`Материалы запуска сохранены: ${paths.stagingDirectory}`);
    }
  } finally {
    Deno.removeSignalListener("SIGINT", rememberInt);
    Deno.removeSignalListener("SIGTERM", rememberTerm);
  }
  const signal = externalSignal ?? outcome?.signal;
  if (signal) {
    Deno.kill(Deno.pid, signal);
    await new Promise(() => {});
  }
  if (outcome?.code) return outcome.code;
  if (failure || !diagnosticValid) {
    if (!outcome) throw failure;
    return 4;
  }
  return 0;
}
