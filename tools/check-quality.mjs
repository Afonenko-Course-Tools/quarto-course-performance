// Адаптер фактического Deno graph к стандартному typed ESLint.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import tseslint from "typescript-eslint";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import { scope } from "../eslint.config.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
const run = (bin, args) =>
  execFileSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const temporary = mkdtempSync(join(tmpdir(), "course-quality-"));
try {
  const tracked = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0");
  const sourceFiles = [...new Set(tracked)].filter((file) =>
    scope.some((prefix) => file.startsWith(prefix)) &&
    /\.(?:ts|js|cjs)$/.test(file) &&
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
  const denoConfig = JSON.parse(
    readFileSync(scope[0].startsWith("src/") ? "deno.json" : "typecheck/deno.json", "utf8"),
  );
  if (denoConfig.compilerOptions?.strict !== true) throw Error("Quality gate требует strict: true");
  const imports = { ...(denoConfig.imports ?? {}) };
  if (!scope[0].startsWith("src/")) {
    const share = run(process.env.QUARTO ?? "quarto", ["--paths"]).trim().split("\n").at(-1);
    const quarto = JSON.parse(readFileSync(join(share, "deno_std/run_import_map.json"), "utf8"));
    for (const name of ["stdlib/path", "stdlib/fs"]) {
      imports[name] = quarto.imports[name].replace("jsr:/", "jsr:");
    }
    const siblings = dirname(root);
    imports["course-performance/"] = pathToFileURL(
      resolve(
        process.env.COURSE_PERFORMANCE_SOURCE ?? process.env.PERFORMANCE ??
          join(siblings, "quarto-course-performance"),
      ) + "/",
    ).href;
    const providers = new Map();
    const namespaces = new Set();
    for (
      const [name, variable, repo] of [
        ["course-core", "CORE", "quarto-course"],
        ["course-navigation", "CORE", "quarto-course"],
        ["course-prairielearn", "PL", "quarto-course-prairielearn"],
        ["reference-catalog", "QRC", "quarto-reference-catalog"],
        ["project-download", "DOWNLOAD", "quarto-project-download"],
        ["course-site", "SITE", "quarto-project-publish"],
      ]
    ) {
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
  let importMap = process.argv[2];
  if (importMap) {
    Object.assign(imports, JSON.parse(readFileSync(resolve(importMap), "utf8")).imports);
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
  const graph = JSON.parse(
    run("deno", ["info", "--no-lock", "--config", configPath, "--json", entry]),
  );
  const errors = graph.modules.filter((module) => module.error);
  if (errors.length) throw Error(JSON.stringify(errors));
  const byUrl = new Map(graph.modules.map((module) => [module.specifier, module]));
  const byFile = new Map(
    graph.modules.filter((module) => module.local).map((module) => [module.local, module]),
  );
  const options = {
    ...ts.convertCompilerOptionsFromJson(denoConfig.compilerOptions, root).options,
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
      while (graph.redirects[url]) url = graph.redirects[url];
      const module = byUrl.get(url);
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
    overrideConfig: [{ languageOptions: { parserOptions: { programs } } }],
  });
  const results = await eslint.lintFiles(checkedFiles);
  console.log(await (await eslint.loadFormatter("stylish")).format(results));
  if (results.length !== checkedFiles.length || results.some((result) => result.warningCount)) {
    throw Error("Неполный quality scope либо предупреждения линтера");
  }
  let receipt;
  if (results.some((result) => result.errorCount)) process.exitCode = 1;
  else {
    const configured = await Promise.all(
      checkedFiles.map((file) => eslint.calculateConfigForFile(file)),
    );
    receipt = {
      checked: files.length,
      javascriptChecked: javascriptFiles.length,
      structuralChecked: configured.filter((config) => config.rules.complexity?.[0] === 2).length,
      strict: true,
      typescript: ts.version,
      eslint: ESLint.version,
      typescriptESLint: tseslint.parser.meta.version,
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
  if (error.stdout) console.error(String(error.stdout));
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
