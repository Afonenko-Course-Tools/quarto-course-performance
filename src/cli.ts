import { parseCommand } from "./cli/arguments.ts";
import type { NativeRenderRequest } from "./report/types.ts";

const help = `quarto-course-perf — измерение рендера Quarto

Использование:
  quarto-course-perf render [--perf-mode off|summary|cpu] [--perf-output каталог] [аргументы Quarto]
  quarto-course-perf experiment <команда> [параметры]
  quarto-course-perf --help
  quarto-course-perf --version

Параметры --perf- принимаются только перед первым аргументом Quarto.
Полный trace: quarto-course-perf experiment run --mode trace.
`;

export async function main(argv: string[]): Promise<number> {
  const command = parseCommand(argv);
  if (command.kind === "help") {
    console.log(help);
    return 0;
  }
  if (command.kind === "version") {
    const config = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
    console.log(config.version);
    return 0;
  }
  if (command.kind === "experiment") {
    return await (await import("./cli/experiment.ts")).experimentCommand(command.argv);
  }
  const request: NativeRenderRequest = {
    cwd: Deno.cwd(),
    quarto: Deno.env.get("QUARTO") ?? "quarto",
    mode: command.mode,
    nativeArgv: command.nativeArgv,
    ...(command.outputParent === undefined ? {} : { outputParent: command.outputParent }),
  };
  const separator = command.nativeArgv.indexOf("--");
  const options = separator < 0 ? command.nativeArgv : command.nativeArgv.slice(0, separator);
  if (options.includes("--help") || options.includes("-h")) {
    const child = new Deno.Command(request.quarto, {
      args: ["render", ...request.nativeArgv],
      cwd: request.cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    return (await child.status).code;
  }
  // Интерфейс backend вводится задачей 4; загрузка остаётся ленивой.
  const rendererPath = "./runner/render.ts";
  const renderer: { renderCommand(request: NativeRenderRequest): Promise<number> } = await import(
    rendererPath
  );
  return await renderer.renderCommand(request);
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (error) {
    try {
      console.error(error instanceof Error ? error.message : String(error));
    } catch { /* Отказ stderr не меняет код ошибки подготовки. */ }
    Deno.exit(2);
  }
}
