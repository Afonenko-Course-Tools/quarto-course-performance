import { join, relative, resolve } from "node:path";
import type {
  GitProvenance,
  NativeRenderRequest,
  ProcessObservation,
  PublishedRun,
  RunCompletion,
  RunRecord,
} from "../report/types.ts";
import { OwnedProcessError, runOwnedProcess } from "./process.ts";
import { resolveRenderProject } from "../adapters/quarto/inspect.ts";
import { finalizeRun, prepareRunStorage } from "./storage.ts";
import { prepareRenderDiagnostic } from "./diagnostic.ts";
import { type NormalizedRun, normalizeRun } from "../analysis/normalize.ts";
import { writeRunArtifacts } from "../report/run.ts";
import { PublicationError } from "../report/types.ts";
import { validateTelemetryEnvironment } from "./environment.ts";

export async function runNativeRender(
  request: NativeRenderRequest,
  stagingDirectory: string,
  diagnosticEnv: Record<string, string> = {},
  lifecycle: {
    abortSignal?: AbortSignal;
    onObservation?: (observation: ProcessObservation) => void;
  } = {},
): Promise<ProcessObservation> {
  return await runOwnedProcess({
    ...lifecycle,
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
              previous.completion?.kind === "complete"
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
  const started = performance.now(), cancellation = new AbortController();
  let externalSignal: "SIGINT" | "SIGTERM" | null = null;
  let observation: ProcessObservation = {
    native: null,
    command: null,
    streams: { stdout: "not-started", stderr: "not-started" },
    stdioMode: null,
    errors: [],
    observedWallSeconds: 0,
  };
  let normalized: NormalizedRun | undefined, selected: RunRecord | undefined;
  let notify: (record: RunRecord) => void = () => {};
  const terminal = new Promise<RunRecord>((resolve) => {
    notify = resolve;
  });
  const snapshot = (completion: RunCompletion): RunRecord => ({
    schema_version: 2,
    runId: paths.runId,
    request,
    completion,
    command: observation.command,
    streams: { ...observation.streams },
    stdioMode: observation.stdioMode,
    observedWallSeconds: (performance.now() - started) / 1000,
    preparation: [...prepared?.preparation ?? []],
    dataValid: completion.kind === "complete" && (normalized?.dataValid ?? !prepared),
    quality: {
      droppedEvents: normalized?.quality.droppedEvents ?? 0,
      incompleteSpans: normalized?.quality.incompleteSpans ?? 0,
      coverageComplete: completion.kind === "complete" &&
        (normalized?.quality.coverageComplete ?? false),
      errors: [...normalized?.quality.errors ?? [], ...observation.errors],
    },
    versions: {
      tool: "2.0.0",
      quarto: new TextDecoder().decode(version.stdout).trim(),
      deno: prepared?.coverage.runtime.runtime.deno?.version ?? null,
      pandoc: prepared?.coverage.runtime.runtime.pandoc?.version ?? null,
    },
    git,
    collectionDirectory: paths.stagingDirectory,
    artifacts: {},
  });
  const choose = (completion: RunCompletion) => {
    if (selected) return;
    selected = snapshot(completion);
    notify(selected);
  };
  const remember = (signal: "SIGINT" | "SIGTERM") => {
    externalSignal ??= signal;
    if (!selected) {
      choose({
        kind: "incomplete",
        reason: "interrupted",
        requestedSignal: externalSignal,
        native: observation.native,
      });
    }
    // Existing process owner alone forwards to its owned group.
    if (!cancellation.signal.aborted) cancellation.abort(externalSignal);
  };
  const interrupt = () => remember("SIGINT"), term = () => remember("SIGTERM");
  Deno.addSignalListener("SIGINT", interrupt);
  Deno.addSignalListener("SIGTERM", term);
  let previous: PublishedRun | undefined;
  try {
    try {
      previous = await writeRunArtifacts(
        paths.stagingDirectory,
        snapshot({
          kind: "incomplete",
          reason: "not-finalized",
          requestedSignal: null,
          native: null,
        }),
      );
    } catch (cause) {
      if (cause instanceof PublicationError) previous = cause.published;
      if (!selected) throw cause;
    }
    if (!selected) {
      void (async () => {
        try {
          observation = await runNativeRender(request, paths.stagingDirectory, diagnosticEnv, {
            abortSignal: cancellation.signal,
            onObservation(current) {
              observation = current;
              if (current.errors.length) {
                choose({
                  kind: "incomplete",
                  reason: "observation-error",
                  requestedSignal: null,
                  native: current.native,
                });
              }
            },
          });
          if (selected) return;
          if (
            !observation.native || observation.streams.stdout !== "eof" ||
            observation.streams.stderr !== "eof"
          ) throw new Error("Неполное наблюдение Native");
          if (prepared) {
            normalized = await normalizeRun(paths.stagingDirectory);
            if (!normalized.dataValid) throw new Error("Невалидное наблюдение диагностики");
          }
          if (!selected) choose({ kind: "complete", native: observation.native });
        } catch (cause) {
          if (cause instanceof OwnedProcessError) observation = cause.observation;
          if (!selected) {
            observation = {
              ...observation,
              errors: [
                ...observation.errors,
                cause instanceof Error ? cause.message : String(cause),
              ],
            };
            choose({
              kind: "incomplete",
              reason: "observation-error",
              requestedSignal: null,
              native: observation.native,
            });
          }
        }
      })();
    }
    const record = await terminal;
    const publication = record.completion.kind === "complete"
      ? await finalizeRun(paths, record, normalized, previous)
      : await writeRunArtifacts(paths.stagingDirectory, record, undefined, previous);
    diagnostic(
      `Отчёт Performance: ${publication.directory}; completion=${record.completion.kind}; data=${
        record.dataValid ? "VALID" : "INVALID"
      }`,
    );
    return record.completion.kind === "complete"
      ? record.completion.native.code || (record.dataValid ? 0 : 4)
      : 4;
  } catch (cause) {
    if (cause instanceof PublicationError) {
      diagnostic(
        `Ошибка публикации: ${cause.directory}; last confirmed: ${
          cause.published?.directory ?? "нет"
        }`,
      );
    }
    throw cause;
  } finally {
    Deno.removeSignalListener("SIGINT", interrupt);
    Deno.removeSignalListener("SIGTERM", term);
    // Also leave the interrupted lifecycle if publication failed.
    if (externalSignal) {
      Deno.kill(Deno.pid, externalSignal);
      await new Promise<never>(() => {});
    }
  }
}
