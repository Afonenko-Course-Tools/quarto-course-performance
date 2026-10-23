import { join, relative, resolve } from "node:path";
import type {
  BuildOutcome,
  GitProvenance,
  NativeRenderRequest,
  RunRecord,
} from "../report/types.ts";
import { runOwnedProcess } from "./process.ts";
import { resolveRenderProject } from "../adapters/quarto/inspect.ts";
import { finalizeRun, prepareRunStorage } from "./storage.ts";
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
export async function renderCommand(request: NativeRenderRequest): Promise<number> {
  const conflicts = validateTelemetryEnvironment(Deno.env.toObject());
  if (conflicts.length) throw new Error(`Конфликт окружения измерений: ${conflicts.join(", ")}`);
  if (request.mode !== "off") {
    throw new Error("Подготовка диагностического режима ещё не подключена");
  }
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
  let externalSignal: Deno.Signal | null = null;
  const rememberInt = () => {
    externalSignal ??= "SIGINT";
  };
  const rememberTerm = () => {
    externalSignal ??= "SIGTERM";
  };
  Deno.addSignalListener("SIGINT", rememberInt);
  Deno.addSignalListener("SIGTERM", rememberTerm);
  let outcome: BuildOutcome | undefined;
  let failure: unknown;
  try {
    outcome = await runNativeRender(request, paths.stagingDirectory);
    const record: RunRecord = {
      schema_version: 2,
      runId: paths.runId,
      request,
      outcome,
      preparation: [],
      dataValid: true,
      quality: { droppedEvents: 0, incompleteSpans: 0, coverageComplete: false, errors: [] },
      versions: {
        tool: "2.0.0",
        quarto: new TextDecoder().decode(version.stdout).trim(),
        deno: null,
        pandoc: null,
      },
      git,
      collectionDirectory: paths.stagingDirectory,
      outputDirectory: paths.finalDirectory,
      artifacts: {},
    };
    try {
      const directory = await finalizeRun(paths, record);
      console.error(`Отчёт Performance: ${directory}`);
    } catch (e) {
      failure = e;
      console.error(e instanceof Error ? e.message : String(e));
    }
  } catch (e) {
    failure = e;
    console.error(`Материалы запуска сохранены: ${paths.stagingDirectory}`);
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
  if (failure) {
    if (!outcome) throw failure;
    return 4;
  }
  return 0;
}
