import { strict as assert } from "node:assert";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { treeHash } from "../src/sources/snapshot.ts";

/** Проверка распакованного приложения без установки в системные каталоги. */
export async function checkInstalled(root: string): Promise<void> {
  if (!isAbsolute(root)) throw new Error("--root требует абсолютный путь приложения");
  const before = await treeHash(root);
  const temporary = await Deno.makeTempDir({ prefix: "perf installed check " });
  try {
    const course = join(temporary, "foreign course"), cache = join(temporary, "empty cache");
    await Deno.mkdir(course);
    await Deno.mkdir(cache);
    await Deno.writeTextFile(
      join(course, "deno.json"),
      '{"compilerOptions":{"types":["./missing.ts"]},"imports":{"node:path":"./forbidden.ts"}}',
    );
    await Deno.writeTextFile(
      join(course, "_quarto.yml"),
      "project:\n  type: default\nformat: html\n",
    );
    await Deno.writeTextFile(
      join(course, "index.qmd"),
      "---\ntitle: Installed fixture\n---\n\nHello installed tree.\n",
    );
    const flags = [
      "run",
      "--config",
      join(root, "deno.json"),
      "--lock",
      join(root, "deno.lock"),
      "--frozen",
      "--node-modules-dir=manual",
      "--cached-only",
      "-A",
    ];
    const env = {
      ...Deno.env.toObject(),
      DENO_DIR: cache,
      XDG_CACHE_HOME: join(temporary, "xdg-cache"),
    };
    const run = async (entry: string, args: string[]) => {
      const output = await new Deno.Command(Deno.execPath(), {
        args: [...flags, entry, ...args],
        cwd: course,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(output.stdout),
        stderr = new TextDecoder().decode(output.stderr);
      console.log(JSON.stringify({ entry, args, code: output.code, stdout, stderr }));
      assert.equal(output.code, 0, stdout + stderr);
      return stdout;
    };
    assert.match(await run(join(root, "src/cli.ts"), ["--help"]), /quarto-course-perf/);
    await run(join(root, "src/cli.ts"), ["render", "--perf-mode", "summary", "index.qmd"]);
    assert.match(await Deno.readTextFile(join(course, "index.html")), /Hello installed tree/);
    const probe = join(temporary, "trace.ts");
    const module = (path: string) => JSON.stringify(pathToFileURL(join(root, path)).href);
    await Deno.writeTextFile(
      probe,
      `
import {prepareDiagnostic} from ${module("src/runner/diagnostic.ts")};
import {executeScenario} from ${module("src/runner/execute.ts")};
import {normalizeRun} from ${module("src/analysis/normalize.ts")};
import {strict as assert} from "node:assert";
const root = ${JSON.stringify(course)};
await Deno.writeTextFile(root+'/entry.ts', 'export function installedTrace(value: number) { return value + 1; }\\nconsole.log(installedTrace(41));');
const prepared={variant:'candidate',root,manifest:{schema_version:2,experimentId:'installed',projectSource:'fixture/course',replacements:[],sources:[],packages:[],runtime:{}}};
const scenario={id:'installed-trace',cwd:'.',executable:Deno.execPath(),args:['run','--no-config','--no-lock','--cached-only','-A',root+'/entry.ts'],cachePolicy:'repeat-render',mode:'trace',scope:{modules:['entry.ts'],extensions:[],strict:true},resources:{wall:true,cpu:true,peakRss:true}};
const diagnostic=await prepareDiagnostic(scenario,prepared,root+'/diagnostic',Deno.env.get('QUARTO')??'quarto');
scenario.executable=diagnostic.env.QUARTO_DENO;
const result=await executeScenario(scenario,prepared,'trace',{outputRoot:root+'/trace-output',diagnosticEnv:diagnostic.env,preparation:diagnostic.preparation});
assert.equal(result.buildExitCode,0);assert(result.dataValid,JSON.stringify(result));
assert(result.preparation.some(p=>p.kind==='ts-transform'));
const transformed=await Deno.readTextFile(root+'/entry.ts'); assert.match(transformed,/installedTrace/);
const symbols=JSON.parse(await Deno.readTextFile(root+'/entry.ts.symbols.json'));assert.equal(symbols.length,1);
const normalized=await normalizeRun(result.outputDirectory);assert(normalized.events.some(e=>e.event==='begin' && e.operation_id===symbols[0].id));
console.log('installed TS trace PASS',result.outputDirectory);
`,
    );
    await run(probe, []);
    assert.equal(await treeHash(root), before, "Установленное дерево изменилось");
    console.log(
      JSON.stringify({
        status: "PASS",
        root,
        before,
        after: before,
        cacheInitiallyEmpty: true,
        cachedOnly: true,
      }),
    );
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
}
if (import.meta.main) {
  if (Deno.args.length !== 2 || Deno.args[0] !== "--root") {
    throw new Error("check-installed.ts --root /absolute/path");
  }
  await checkInstalled(Deno.args[1]);
}
