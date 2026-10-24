import { resolve } from "node:path";
import type { NativeRenderRequest } from "../../report/types.ts";

export interface ProjectTarget {
  projectRoot: string;
  kind: "project" | "standalone";
  resources?: string[];
  outputDirectory?: string;
}

// Только параметры, значения которых могут быть ошибочно приняты за input.
// Остальные параметры принадлежат Quarto/Pandoc и не валидируются здесь.
const valueOptions = new Set([
  "--to",
  "-t",
  "--output",
  "-o",
  "--output-dir",
  "--metadata",
  "-M",
  "--site-url",
  "--execute-param",
  "-P",
  "--execute-params",
  "--execute-dir",
  "--log",
  "--log-level",
  "--log-format",
  "--profile",
]);
const switches = new Set([
  "--execute",
  "--no-execute",
  "--execute-daemon-restart",
  "--execute-debug",
  "--use-freezer",
  "--cache",
  "--no-cache",
  "--cache-refresh",
  "--no-clean",
  "--debug",
  "--quiet",
  "--toc",
  "--no-toc",
  "--standalone",
  "-s",
]);

function inspectArguments(argv: readonly string[], cwd: string): string[] {
  let input: string | undefined, uncertain = false, positional = false;
  const profiles: string[] = [];
  const ambiguous = () =>
    new Error(
      "Неоднозначная цель render: укажите одну цель перед параметрами; значения дополнительных параметров задайте как --key=value",
    );
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!positional && arg === "--") {
      positional = true;
      continue;
    }
    if (!positional && arg.startsWith("-")) {
      const equal = arg.indexOf("="), name = equal < 0 ? arg : arg.slice(0, equal);
      if (name === "--profile") {
        const profile = equal < 0 ? argv[++i] : arg.slice(equal + 1);
        if (!profile || profile.startsWith("--")) throw new Error("Необходимо значение --profile");
        profiles.push("--profile", profile);
      } else if (name === "--execute-daemon") {
        // Публичный render принимает необязательное число секунд.
        if (equal < 0 && /^\d+$/.test(argv[i + 1] ?? "")) i++;
      } else if (valueOptions.has(name)) {
        if (equal < 0) i++;
      } else if (equal < 0 && !switches.has(name)) {
        // После уже выделенной цели чужие аргументы целиком принадлежат Quarto.
        uncertain = true;
      }
      continue;
    }
    if (uncertain && !positional) {
      if (input === undefined) throw ambiguous();
      continue;
    }
    if (input !== undefined) throw ambiguous();
    input = arg;
  }
  return [...(input === undefined ? [] : [resolve(cwd, input)]), ...profiles];
}

export function explicitOutputDirectory(argv: readonly string[]): string | undefined {
  let selected: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg.startsWith("--output-dir=")) selected = arg.slice(13);
    else if (arg === "--output-dir") selected = argv[++i];
    else if (valueOptions.has(arg)) i++;
  }
  return selected;
}

export async function resolveRenderProject(request: NativeRenderRequest): Promise<ProjectTarget> {
  const args = inspectArguments(request.nativeArgv, request.cwd);
  const output = await new Deno.Command(request.quarto, {
    args: ["inspect", ...args],
    cwd: request.cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(`quarto inspect: ${new TextDecoder().decode(output.stderr).trim()}`);
  }
  const inspected = JSON.parse(new TextDecoder().decode(output.stdout));
  const project = inspected.project ?? inspected;
  if (typeof project.dir !== "string" || !project.dir) {
    throw new Error("quarto inspect не вернул каталог проекта или самостоятельного документа");
  }
  const outputDir = explicitOutputDirectory(request.nativeArgv) ??
    project.config?.project?.["output-dir"];
  return {
    ...(typeof outputDir === "string" && outputDir
      ? { outputDirectory: resolve(request.cwd, project.dir, outputDir) }
      : {}),
    ...(Array.isArray(project.config?.project?.resources) && project.config.project.resources.length
      ? { resources: project.config.project.resources }
      : {}),
    projectRoot: resolve(request.cwd, project.dir),
    kind: Array.isArray(project.files?.config) && project.files.config.length > 0
      ? "project"
      : "standalone",
  };
}
