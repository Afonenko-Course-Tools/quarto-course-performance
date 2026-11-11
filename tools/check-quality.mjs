// Адаптер фактического Deno graph к стандартному typed ESLint.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import tseslint from 'typescript-eslint';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { scope } from '../eslint.config.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const temporary = mkdtempSync(join(tmpdir(), 'course-quality-'));
try {
  const tracked = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0');
  const files = [...new Set(tracked)].filter(file => scope.some(prefix => file.startsWith(prefix)) &&
    file.endsWith('.ts') && !/(^|\/)(vendor|node_modules|generated|_generated)(\/|$)/.test(file) && existsSync(file))
    .sort().map(file => resolve(file));
  if (!files.length) throw Error('Quality scope пуст: проверка без собственного production-кода запрещена');
  const denoConfig = JSON.parse(readFileSync(scope[0].startsWith('src/') ? 'deno.json' : 'typecheck/deno.json', 'utf8'));
  if (denoConfig.compilerOptions?.strict !== true) throw Error('Quality gate требует strict: true');
  const imports = { ...(denoConfig.imports ?? {}) };
  if (!scope[0].startsWith('src/')) {
    const share = run(process.env.QUARTO ?? 'quarto', ['--paths']).trim().split('\n').at(-1);
    const quarto = JSON.parse(readFileSync(join(share, 'deno_std/run_import_map.json'), 'utf8'));
    for (const name of ['stdlib/path', 'stdlib/fs']) imports[name] = quarto.imports[name].replace('jsr:/', 'jsr:');
    const siblings = dirname(root);
    imports['course-performance/'] = pathToFileURL(resolve(process.env.COURSE_PERFORMANCE_SOURCE ?? join(siblings, 'quarto-course-performance')) + '/').href;
    for (const [name, repo, extension] of [
      ['course-core', 'quarto-course', 'course-core'],
      ['reference-catalog', 'quarto-reference-catalog', 'reference-catalog'],
      ['project-download', 'quarto-project-download', 'project-download'],
    ]) imports[name + '/'] = pathToFileURL(join(siblings, repo, '_extensions', extension) + '/').href;
    imports['pl-native/'] = pathToFileURL(join(root, '_extensions/course-prairielearn/application') + '/').href;
  }
  let importMap = process.argv[2];
  if (!importMap && scope[0].startsWith('_extensions/course-prairielearn/')) {
    importMap = join(temporary, 'providers.json');
    run(process.env.QUARTO ?? 'quarto', ['run', 'tools/native-core-import-map.ts',
      join(dirname(root), 'quarto-course'), importMap,
      join(dirname(root), 'quarto-reference-catalog'), join(dirname(root), 'quarto-project-download')]);
  }
  if (importMap) Object.assign(imports, JSON.parse(readFileSync(resolve(importMap), 'utf8')).imports);
  const configPath = join(temporary, 'deno.json');
  writeFileSync(configPath, JSON.stringify({ ...denoConfig, imports }));
  const entry = join(temporary, 'entry.ts');
  writeFileSync(entry, files.map(file => `import ${JSON.stringify(pathToFileURL(file).href)};`).join('\n'));
  const graph = JSON.parse(run('deno', ['info', '--no-lock', '--config', configPath, '--json', entry]));
  const errors = graph.modules.filter(module => module.error);
  if (errors.length) throw Error(JSON.stringify(errors));
  const byUrl = new Map(graph.modules.map(module => [module.specifier, module]));
  const byFile = new Map(graph.modules.filter(module => module.local).map(module => [module.local, module]));
  const options = { ...ts.convertCompilerOptionsFromJson(denoConfig.compilerOptions, root).options,
    noEmit: true, allowImportingTsExtensions: true, allowJs: true,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext, skipLibCheck: true, types: ['node'],
    typeRoots: [join(root, 'node_modules/@types')] };
  const globals = join(temporary, 'deno.d.ts');
  // `deno types` уже объединяет эти библиотеки; TS не знает имён встроенных Deno libs.
  writeFileSync(globals, run('deno', ['types']).replace(/^\/\/\/ <reference lib="(?:deno\.[^"]*|node)" \/>\r?\n/gm, ''));
  const host = ts.createCompilerHost(options);
  host.resolveModuleNames = (names, containing) => names.map(name => {
    const dep = byFile.get(containing)?.dependencies?.find(item => item.specifier === name);
    let url = dep?.type?.specifier ?? dep?.code?.specifier;
    while (graph.redirects[url]) url = graph.redirects[url];
    const module = byUrl.get(url);
    return module?.local ? { resolvedFileName: module.local,
      extension: module.mediaType === 'JavaScript' ? ts.Extension.Js : ts.Extension.Ts } :
      ts.resolveModuleName(name, containing, options, host).resolvedModule;
  });
  const program = ts.createProgram([...files, globals], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(item => !item.file || files.includes(item.file.fileName));
  if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
  const eslint = new ESLint({ overrideConfig: [{ languageOptions: { parserOptions: { programs: [program] } } }] });
  const results = await eslint.lintFiles(files);
  if (results.length !== files.length || results.some(result => result.warningCount)) throw Error('Неполный quality scope либо предупреждения линтера');
  console.log(await (await eslint.loadFormatter('stylish')).format(results));
  let receipt;
  if (results.some(result => result.errorCount)) process.exitCode = 1;
  else {
    const configured = await Promise.all(files.map(file => eslint.calculateConfigForFile(file)));
    receipt = { checked: files.length, structuralChecked: configured.filter(config => config.rules.complexity?.[0] === 2).length, strict: true, typescript: ts.version, eslint: ESLint.version, typescriptESLint: tseslint.parser.meta.version, graphModules: graph.modules.length };
  }
  console.log(run(join(root, 'node_modules/.bin/depcruise'), ['--config', '.dependency-cruiser.json', '--output-type', 'err-long', ...scope.map(prefix => prefix.replace(/\/$/, ''))]));
  if (!process.exitCode) console.log(JSON.stringify(receipt));
} catch (error) {
  if (error.stdout) console.error(String(error.stdout));
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
