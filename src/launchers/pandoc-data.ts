import { isAbsolute, join, resolve } from "node:path";
import { pandocBuiltinInit, preparePandocData } from "./setup.ts";

/** Выбор только из фактического argv и публичного default выбранного Pandoc. */
export async function preparePandocArgs(
  binary: string,
  original: string[],
  env: Record<string, string>,
  id: string,
) {
  // Публичные опции с обязательным отдельным значением: Pandoc 3.10 --help.
  // Необязательные [=VALUE] не поглощают следующий отдельный аргумент.
  const valueOptions = new Set([
    "-f",
    "-r",
    "--from",
    "--read",
    "-t",
    "-w",
    "--to",
    "--write",
    "-o",
    "--output",
    "-M",
    "--metadata",
    "--metadata-file",
    "--template",
    "-V",
    "--variable",
    "--variable-json",
    "--wrap",
    "--toc-depth",
    "--number-offset",
    "--top-level-division",
    "--extract-media",
    "--resource-path",
    "-H",
    "--include-in-header",
    "-B",
    "--include-before-body",
    "-A",
    "--include-after-body",
    "--highlight-style",
    "--syntax-definition",
    "--syntax-highlighting",
    "--dpi",
    "--eol",
    "--columns",
    "--tab-stop",
    "--pdf-engine",
    "--pdf-engine-opt",
    "--reference-doc",
    "--request-header",
    "--abbreviations",
    "--typst-input",
    "--indented-code-classes",
    "--default-image-extension",
    "-F",
    "--filter",
    "-L",
    "--lua-filter",
    "--shift-heading-level-by",
    "--base-header-level",
    "--track-changes",
    "--reference-location",
    "--figure-caption-position",
    "--table-caption-position",
    "--markdown-headings",
    "--slide-level",
    "--email-obfuscation",
    "--id-prefix",
    "-T",
    "--title-prefix",
    "-c",
    "--css",
    "--epub-subdirectory",
    "--epub-cover-image",
    "--epub-metadata",
    "--epub-embed-font",
    "--split-level",
    "--chunk-template",
    "--epub-chapter-level",
    "--ipynb-output",
    "--bibliography",
    "--csl",
    "--citation-abbreviations",
    "--log",
    "-D",
    "--print-default-template",
    "--print-default-data-file",
    "--print-highlight-style",
  ]);
  const args: string[] = [];
  let source: string | undefined, lastData = -1, lastDefaults = -1, nativeSeparator = -1;
  for (let i = 0; i < original.length; i++) {
    const arg = original[i];
    if (arg === "--") {
      nativeSeparator = args.length;
      args.push(...original.slice(i));
      break;
    }
    if (arg === "--data-dir") {
      if (!original[i + 1]) throw new Error("Необходимо значение --data-dir");
      lastData = i;
      source = resolve(original[++i]);
    } else if (arg.startsWith("--data-dir=")) {
      if (!arg.slice("--data-dir=".length)) throw new Error("Необходимо значение --data-dir");
      lastData = i;
      source = resolve(arg.slice("--data-dir=".length));
    } else if (valueOptions.has(arg)) {
      args.push(arg);
      if (original[i + 1] !== undefined) args.push(original[++i]);
    } else {
      if (arg === "--defaults" || arg === "-d") {
        lastDefaults = i;
        args.push(arg);
        if (!original[i + 1]) throw new Error("Необходимо значение --defaults");
        args.push(original[++i]);
      } else {
        if (arg.startsWith("--defaults=") || /^\-d.+/.test(arg)) lastDefaults = i;
        args.push(arg);
      }
    }
  }
  if (lastDefaults > lastData) {
    throw new Error(
      "Диагностика не разрешает --defaults после последнего --data-dir: укажите явный --data-dir после всех defaults",
    );
  }
  const defaultSelection = source === undefined;
  if (defaultSelection) {
    const result = await new Deno.Command(binary, {
      args: ["--version"],
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error("Не удалось определить default data-dir выбранного Pandoc");
    }
    source = new TextDecoder().decode(result.stdout).match(/^User data directory: (.+)$/m)?.[1]
      ?.trim();
    if (!source || !isAbsolute(source)) {
      throw new Error("Выбранный Pandoc не сообщил абсолютный default data-dir");
    }
  }
  let dataDir = env.COURSE_PERF_DATA_DIR;
  let preparation;
  if (source !== env.COURSE_PERF_SOURCE_DATA_DIR) {
    dataDir = join(env.COURSE_PERF_OUTPUT_DIR, "pandoc-data", id);
    let copySource = source!;
    let missingDefault = false;
    try {
      await Deno.lstat(copySource);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) || !defaultSelection) throw error;
      // Native отсутствующий пользовательский каталог не создаётся и не меняется.
      missingDefault = true;
      copySource = join(env.COURSE_PERF_OUTPUT_DIR, "pandoc-empty-default", id);
      await Deno.mkdir(copySource, { recursive: true });
    }
    const receipt = await preparePandocData(
      copySource,
      dataDir,
      env.COURSE_PERF_INIT_LUA,
      await pandocBuiltinInit(binary, env),
    );
    preparation = {
      ...receipt,
      selectedSource: source,
      selection: defaultSelection ? "native-default" : "explicit",
      missingDefault,
    };
  }
  // Не превращать аргументы после нативного разделителя в параметры.
  args.splice(nativeSeparator < 0 ? args.length : nativeSeparator, 0, "--data-dir", dataDir);
  return { args, preparation };
}
