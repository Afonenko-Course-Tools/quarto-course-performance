// Адаптер фактического Deno graph к стандартному typed ESLint.
import { execFileSync } from "node:child_process";
import process from "node:process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import tseslint from "typescript-eslint";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import { scope, structuralScope } from "../eslint.config.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
/** @param {string} bin @param {string[]} args */
const run = (bin, args) =>
  execFileSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

/** @typedef {{ specifier?: string }} GraphResolution */
/** @typedef {{ specifier: string, type?: GraphResolution, code?: GraphResolution }} GraphDependency */
/** @typedef {{ specifier: string, local?: string, mediaType?: string, error?: unknown, dependencies?: GraphDependency[] }} GraphModule */
/** @typedef {{ modules: GraphModule[], redirects: Record<string, string> }} DenoGraph */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is unknown[]} */
function isArray(value) {
  return Array.isArray(value);
}
/** @param {unknown} value @returns {value is Record<string, string>} */
function isStringMap(value) {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
/** @param {unknown} value @returns {value is GraphResolution} */
function isResolution(value) {
  return isRecord(value) && (!("specifier" in value) || typeof value.specifier === "string");
}
/** @param {unknown} value @returns {value is GraphDependency} */
function isDependency(value) {
  return isRecord(value) && typeof value.specifier === "string" &&
    (!("type" in value) || isResolution(value.type)) &&
    (!("code" in value) || isResolution(value.code));
}
/** @param {unknown} value @returns {value is GraphModule} */
function isModule(value) {
  return isRecord(value) && typeof value.specifier === "string" &&
    (!("local" in value) || typeof value.local === "string") &&
    (!("mediaType" in value) || typeof value.mediaType === "string") &&
    (!("dependencies" in value) ||
      (isArray(value.dependencies) && value.dependencies.every(isDependency)));
}
/** @param {unknown} value @returns {DenoGraph} */
function parseGraph(value) {
  if (
    !isRecord(value) || !isArray(value.modules) || !value.modules.every(isModule) ||
    !isStringMap(value.redirects)
  ) {
    throw Error("Некорректный Deno module graph");
  }
  return { modules: value.modules, redirects: value.redirects };
}
/** @param {unknown} value @returns {Record<string, unknown>} */
function requireRecord(value) {
  if (!isRecord(value)) throw Error("Ожидается JSON object");
  return value;
}
/** @param {unknown} value @returns {Record<string, string>} */
function importEntries(value) {
  if (!isStringMap(value)) throw Error("Некорректный imports map");
  return value;
}
/** @param {string} path @returns {unknown} */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
/** @param {unknown} value */
function hasStructuralRules(value) {
  const config = requireRecord(value);
  const rules = requireRecord(config.rules);
  const complexity = rules.complexity;
  return isArray(complexity) && complexity[0] === 2;
}

const temporary = mkdtempSync(join(tmpdir(), "course-quality-"));
try {
  const tracked = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0");
  const sourceFiles = [...new Set(tracked)].filter((file) =>
    scope.some((prefix) => file.startsWith(prefix)) &&
    /\.(?:ts|js|cjs|mjs)$/.test(file) &&
    !/(^|\/)(vendor|node_modules|generated|_generated)(\/|$)/.test(file) &&
    existsSync(file)
  )
    .sort().map((file) => resolve(file));
  // native-validators.js — генерируемый standalone AJV artifact; проверяется воспроизводимостью и потребляющим .d.ts.
  const generated = new Set(
    ["_extensions/course-prairielearn/application/native-validators.js"].map((file) =>
      resolve(file)
    ),
  );
  const files = sourceFiles.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
  const javascriptFiles = sourceFiles.filter((file) =>
    !file.endsWith(".ts") && !generated.has(file)
  );
  if (!files.length) {
    throw Error("Quality scope пуст: проверка без собственного production-кода запрещена");
  }
  const firstScope = scope[0];
  if (!firstScope) throw Error("Пустой production scope");
  const denoConfig = requireRecord(readJson(
    firstScope.startsWith("src/") ? "deno.json" : "typecheck/deno.json",
  ));
  const compilerOptions = requireRecord(denoConfig.compilerOptions);
  if (compilerOptions.strict !== true) throw Error("Quality gate требует strict: true");
  const imports = { ...importEntries(denoConfig.imports ?? {}) };
  if (!firstScope.startsWith("src/")) {
    const share = run(process.env.QUARTO ?? "quarto", ["--paths"]).trim().split("\n").at(-1);
    if (!share) throw Error("quarto --paths не вернул share");
    const quarto = requireRecord(readJson(join(share, "deno_std/run_import_map.json")));
    const quartoImports = importEntries(quarto.imports);
    for (const name of ["stdlib/path", "stdlib/fs"]) {
      const target = quartoImports[name];
      if (!target) throw Error("Отсутствует Quarto import: " + name);
      imports[name] = target.replace("jsr:/", "jsr:");
    }
    const siblings = dirname(root);
    imports["course-performance/"] = pathToFileURL(
      resolve(
        process.env.COURSE_PERFORMANCE_SOURCE ?? process.env.PERFORMANCE ??
          join(siblings, "quarto-course-performance"),
      ) + "/",
    ).href;
    /** @type {Map<string, string>} */
    const providers = new Map();
    /** @type {Set<string>} */
    const namespaces = new Set();
    /** @type {Array<[string, string, string]>} */
    const providerEntries = [
      ["course-core", "CORE", "quarto-course"],
      ["course-navigation", "CORE", "quarto-course"],
      ["course-prairielearn", "PL", "quarto-course-prairielearn"],
      ["reference-catalog", "QRC", "quarto-reference-catalog"],
      ["project-download", "DOWNLOAD", "quarto-project-download"],
      ["course-site", "SITE", "quarto-project-publish"],
    ];
    for (const [name, variable, repo] of providerEntries) {
      const source = process.env[variable] ?? join(siblings, repo);
      const extension = [
        join(source, "_extensions", name),
        join(source, "_extensions/Afonenko-Course-Tools", name),
        source,
      ]
        .find((path) => existsSync(join(path, "public.ts")));
      if (!extension) continue;
      const target = pathToFileURL(resolve(extension) + "/").href;
      imports[name + "/"] = target;
      providers.set(name, target);
      namespaces.add(dirname(resolve(extension)));
      if (name === "course-prairielearn") {
        imports["pl-native/"] = new URL("application/", target).href;
      }
    }
    for (const namespace of namespaces) {
      for (const [name, target] of providers) {
        imports[pathToFileURL(join(namespace, name) + "/").href] = target;
      }
    }
  }
  const importMap = process.argv[2];
  if (importMap) {
    Object.assign(imports, importEntries(requireRecord(readJson(resolve(importMap))).imports));
  }
  const configPath = join(temporary, "deno.json");
  writeFileSync(configPath, JSON.stringify({ ...denoConfig, imports }));
  const entry = join(temporary, "entry.ts");
  writeFileSync(
    entry,
    [...files, ...javascriptFiles].map((file) =>
      `import ${JSON.stringify(pathToFileURL(file).href)};`
    ).join("\n"),
  );
  const graph = parseGraph(JSON.parse(
    run("deno", ["info", "--no-lock", "--config", configPath, "--json", entry]),
  ));
  const errors = graph.modules.filter((module) => module.error);
  if (errors.length) throw Error(JSON.stringify(errors));
  const byUrl = new Map(graph.modules.map((module) => [module.specifier, module]));
  const byFile = new Map(
    graph.modules.filter((module) => module.local).map((module) => [module.local, module]),
  );
  const options = {
    ...ts.convertCompilerOptionsFromJson(compilerOptions, root).options,
    noEmit: true,
    allowImportingTsExtensions: true,
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [join(root, "node_modules/@types")],
  };
  const globals = join(temporary, "deno.d.ts");
  // `deno types` уже объединяет эти библиотеки; TS не знает имён встроенных Deno libs.
  writeFileSync(
    globals,
    run("deno", ["types"]).replace(/^\/\/\/ <reference lib="(?:deno\.[^"]*|node)" \/>\r?\n/gm, ""),
  );
  const host = ts.createCompilerHost(options);
  host.resolveModuleNames = (names, containing) =>
    names.map((name) => {
      const dep = byFile.get(containing)?.dependencies?.find((item) => item.specifier === name);
      let url = dep?.type?.specifier ?? dep?.code?.specifier;
      while (url && graph.redirects[url]) url = graph.redirects[url];
      const module = url ? byUrl.get(url) : undefined;
      return module?.local
        ? {
          resolvedFileName: module.local,
          extension: module.mediaType === "JavaScript" ? ts.Extension.Js : ts.Extension.Ts,
        }
        : ts.resolveModuleName(name, containing, options, host).resolvedModule;
    });
  const program = ts.createProgram([...files, globals], options, host);
  const programs = [program];
  if (javascriptFiles.length) {
    // src/bridge исполняются Deno: JS получает настоящие Deno globals и тот же import graph.
    programs.push(
      ts.createProgram([...javascriptFiles, globals], { ...options, checkJs: true }, host),
    );
  }
  const checkedFiles = [...files, ...javascriptFiles];
  const diagnostics = programs.flatMap((program) => ts.getPreEmitDiagnostics(program))
    .filter((item) => !item.file || checkedFiles.includes(item.file.fileName));
  if (diagnostics.length) {
    throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (file) => file,
      getNewLine: () => "\n",
    }));
  }
  const eslint = new ESLint({
    overrideConfig: [{ files: structuralScope, languageOptions: { parserOptions: { programs } } }],
  });
  // Node helpers имеют собственный TS project; они не попадают в production Deno graph.
  run(join(root, "node_modules/.bin/tsc"), ["--project", "typecheck/helpers.json"]);
  const helperFiles = [...new Set(tracked)].filter((file) =>
    (/^[^/]+\.(?:js|cjs|mjs)$/.test(file) || /^tools\/.*\.(?:js|cjs|mjs)$/.test(file)) &&
    existsSync(file) &&
    !/(^|\/)(vendor|node_modules|generated|_generated)(\/|$)/.test(file)
  ).sort().map((file) => resolve(file));
  const lintFiles = [...checkedFiles, ...helperFiles];
  const results = await eslint.lintFiles(lintFiles);
  console.log(await (await eslint.loadFormatter("stylish")).format(results));
  if (results.length !== lintFiles.length || results.some((result) => result.warningCount)) {
    throw Error("Неполный quality scope либо предупреждения линтера");
  }
  const pluginMetadata = requireRecord(tseslint.plugin.meta);
  const pluginVersion = pluginMetadata.version;
  if (typeof pluginVersion !== "string") throw Error("Отсутствует версия typescript-eslint");
  let receipt;
  if (results.some((result) => result.errorCount)) process.exitCode = 1;
  else {
    const configured = await Promise.all(
      checkedFiles.map(async (file) =>
        hasStructuralRules(await eslint.calculateConfigForFile(file))
      ),
    );
    receipt = {
      checked: files.length,
      helpersChecked: helperFiles.length,
      javascriptChecked: javascriptFiles.length,
      structuralChecked: configured.filter(Boolean).length,
      strict: true,
      typescript: ts.version,
      eslint: ESLint.version,
      typescriptESLint: pluginVersion,
      graphModules: graph.modules.length,
    };
  }
  console.log(
    run(join(root, "node_modules/.bin/depcruise"), [
      "--config",
      ".dependency-cruiser.json",
      "--output-type",
      "err-long",
      ...scope.map((prefix) => prefix.replace(/\/$/, "")),
    ]),
  );
  if (!process.exitCode) console.log(JSON.stringify(receipt));
} catch (error) {
  if (error instanceof Error && "stdout" in error && error.stdout) {
    console.error(String(error.stdout));
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
