import { join } from "node:path";
import type { BuildOutcome, NativeRenderRequest } from "../report/types.ts";
import { runOwnedProcess } from "./process.ts";
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

// Final report/storage и diagnostic preparation подключаются следующими этапами.
export async function renderCommand(request: NativeRenderRequest): Promise<number> {
  const conflicts = validateTelemetryEnvironment(Deno.env.toObject());
  if (conflicts.length) throw new Error(`Конфликт окружения измерений: ${conflicts.join(", ")}`);
  if (request.mode !== "off") {
    throw new Error("Подготовка диагностического режима ещё не подключена");
  }
  const staging = await Deno.makeTempDir({ prefix: "quarto-course-perf-" });
  return (await runNativeRender(request, staging)).code;
}
