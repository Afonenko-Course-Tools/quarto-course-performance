import { completedNative, validateRunRecord } from "../src/report/types.ts";
import { strict as assert } from "node:assert";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyTree, files } from "../src/sources/files.ts";
import { prepareDiagnostic } from "../src/runner/diagnostic.ts";
import { executeScenario, withScenarioSignals } from "../src/runner/execute.ts";
import { normalizeRun, operationAttribution } from "../src/analysis/normalize.ts";
import { installPackages } from "../src/sources/packages.ts";
import type { SourceManifest, SourceSelection } from "../src/config/types.ts";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const json = async (path: string, value: unknown) =>
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n", { createNew: true });

/** Исключения — только явные относительные имена; HTML/ZIP всегда сравниваются побайтно. */
export async function compareStrictTrees(left: string, right: string, exceptions: string[] = []) {
  for (const name of exceptions) {
    if (
      !name || isAbsolute(name) || name.split("/").some((p) => !p || p === "." || p === "..") ||
      /[\\*?\[\]]/.test(name) || /\.(html?|zip)$/i.test(name)
    ) throw new Error(`Недопустимое динамическое исключение: ${name}`);
  }
  const a = new Map((await files(left)).map((path) => [relative(left, path), path])),
    b = new Map((await files(right)).map((path) => [relative(right, path), path]));
  const differences: { path: string; kind: "missing" | "bytes" }[] = [],
    dynamic: typeof differences = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(path), y = b.get(path);
    if (!x || !y) {
      differences.push({ path, kind: "missing" });
      continue;
    }
    const [first, second] = await Promise.all([Deno.readFile(x), Deno.readFile(y)]);
    if (first.length === second.length && first.every((byte, index) => byte === second[index])) {
      continue;
    }
    (exceptions.includes(path) ? dynamic : differences).push({ path, kind: "bytes" });
  }
  return {
    equivalent: differences.length === 0,
    files: a.size,
    html: [...a.keys()].filter((path) => path.endsWith(".html")).length,
    zip: [...a.keys()].filter((path) => path.endsWith(".zip")).length,
    differences,
    dynamic,
    exceptions,
  };
}

type JavaInputs = { project: string; output: string; replacementOwner: string };
const usage =
  "check-java-general-use.ts --project /absolute/checkout --output /absolute/new-evidence --replacement-owner /absolute/owner-checkout";

function requireAbsolute(value: string, flag: string) {
  assert(typeof value === "string" && isAbsolute(value), `${flag} требует абсолютный путь`);
}

export function parseJavaArgs(args: string[]): JavaInputs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!["--project", "--output", "--replacement-owner"].includes(key) || !value || flags[key]) {
      throw new Error(usage);
    }
    flags[key] = value;
  }
  for (const key of ["--project", "--output", "--replacement-owner"]) {
    requireAbsolute(flags[key], key);
  }
  return {
    project: flags["--project"],
    output: flags["--output"],
    replacementOwner: flags["--replacement-owner"],
  };
}

const git = async (path: string, args: string[]) => {
  const result = await new Deno.Command("git", {
    args: ["--no-optional-locks", "-C", path, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(result.success, decode(result.stderr));
  return decode(result.stdout).trim();
};

/** Только чтение: все входы проверяются до создания evidence и запуска матрицы. */
export async function preflightJava(
  project: string,
  output: string,
  replacementOwner: string,
): Promise<JavaInputs> {
  requireAbsolute(project, "--project");
  requireAbsolute(output, "--output");
  requireAbsolute(replacementOwner, "--replacement-owner");
  project = await Deno.realPath(project);
  assert((await Deno.stat(project)).isDirectory, "--project должен быть каталогом");
  // Для нового output mkdir требует существующий parent. realPath учитывает
  // symlink до обработки ..; resolve исходной строки здесь был бы недостаточен.
  try {
    output = await Deno.realPath(output);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    output = resolve(await Deno.realPath(dirname(output)), basename(output));
  }
  const within = relative(project, output);
  assert(
    within && (within === ".." || within.startsWith("../") || isAbsolute(within)),
    "Evidence должен находиться вне source",
  );
  try {
    replacementOwner = await Deno.realPath(replacementOwner);
    assert((await Deno.stat(replacementOwner)).isDirectory);
    assert((await Deno.lstat(join(replacementOwner, "_extensions"))).isDirectory);
    assert((await Deno.lstat(join(replacementOwner, "_extensions/reference-catalog"))).isDirectory);
    assert(
      (await Deno.stat(join(replacementOwner, "_extensions/reference-catalog/_extension.yml")))
        .isFile,
    );
    await files(join(replacementOwner, "_extensions/reference-catalog"));
    const ownerRoot = await git(replacementOwner, ["rev-parse", "--show-toplevel"]);
    assert.equal(await Deno.realPath(ownerRoot), replacementOwner, "Нужен корень owner checkout");
    await git(replacementOwner, ["rev-parse", "--verify", "HEAD"]);
    assert.equal(
      await git(replacementOwner, ["status", "--porcelain"]),
      "",
      "Owner должен быть clean",
    );
  } catch (error) {
    throw new Error(
      `--replacement-owner: нужен чистый owner checkout с пакетом reference-catalog: ${error}`,
    );
  }
  return { project, output, replacementOwner };
}

export async function checkJava(project: string, output: string, replacementOwner: string) {
  return await withScenarioSignals((abortSignal) =>
    checkJavaImpl(project, output, replacementOwner, abortSignal)
  );
}
async function checkJavaImpl(
  project: string,
  output: string,
  replacementOwner: string,
  abortSignal: AbortSignal,
) {
  ({ project, output, replacementOwner } = await preflightJava(project, output, replacementOwner));
  await Deno.mkdir(output, { recursive: false });
  const commands: unknown[] = [], gates: unknown[] = [];
  const environment = Object.fromEntries([
    "PATH",
    "DENO_DIR",
    "XDG_CACHE_HOME",
    "QUARTO",
    "QUARTO_DENO",
    "QUARTO_PANDOC",
    "JAVA_HOME",
    "GRADLE_USER_HOME",
    "JUPYTER_CONFIG_DIR",
    "JUPYTER_RUNTIME_DIR",
    "JUPYTER_DATA_DIR",
    "IPYTHONDIR",
    "TEXMFVAR",
    "TEXMFCONFIG",
  ].flatMap((key) => Deno.env.has(key) ? [[key, Deno.env.get(key)!]] : []));
  const run = async (label: string, executable: string, args: string[], cwd = app) => {
    const startUTC = new Date().toISOString();
    const result = await new Deno.Command(executable, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();
    await Deno.writeFile(join(output, label + ".stdout.log"), result.stdout, { createNew: true });
    await Deno.writeFile(join(output, label + ".stderr.log"), result.stderr, { createNew: true });
    const command = {
      label,
      executable,
      argv: args,
      cwd,
      environment,
      startUTC,
      endUTC: new Date().toISOString(),
      exit: result.code,
      signal: result.signal,
    };
    await json(join(output, label + ".command.json"), command);
    commands.push(command);
    console.log(`${label}: exit ${result.code}`);
    return result;
  };
  const sourceSHA = await git(project, ["rev-parse", "HEAD"]);
  assert.equal(await git(project, ["status", "--porcelain"]), "", "Source должен быть clean");
  const executionHEAD = await git(app, ["rev-parse", "HEAD"]);
  assert.equal(
    await git(app, [
      "status",
      "--porcelain",
      "--",
      "src",
      "tools",
      "tests",
      "deno.json",
      ".github",
    ]),
    "",
    "Перед матрицей закоммитьте код",
  );
  const quarto = Deno.env.get("QUARTO") ?? "/usr/bin/quarto";
  const flags = [
    "run",
    "--config",
    join(app, "deno.json"),
    "--lock",
    join(app, "deno.lock"),
    "--frozen",
    "--node-modules-dir=manual",
    "--cached-only",
    "-A",
    join(app, "src/cli.ts"),
  ];
  const tools: Record<string, unknown> = {};
  for (
    const [name, executable, args] of [
      ["quarto", quarto, ["--version"]],
      ["deno", Deno.execPath(), ["--version"]],
      ["pandoc", "/opt/quarto/bin/tools/x86_64/pandoc", ["--version"]],
      ["java", "java", ["--version"]],
      ["gradle", "gradle", ["--version"]],
    ] as const
  ) {
    const result = await run("tool-" + name, executable, [...args]);
    assert(result.success, name);
    tools[name] = decode(result.stdout).trim();
  }
  const archive = join(output, "source.tar");
  assert(
    (await run("archive", "git", [
      "-C",
      project,
      "archive",
      "--format=tar",
      "--output=" + archive,
      sourceSHA,
    ])).success,
  );
  // Постоянный внешний рабочий каталог сохраняет одинаковые пути native HTML.
  const renderParent = await Deno.makeTempDir({ dir: "/tmp", prefix: "quarto-perf-java-" });
  const renderRoot = join(renderParent, "course");
  const makeCopy = async (label: string) => {
    await Deno.remove(renderRoot, { recursive: true }).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
    const root = renderRoot;
    await Deno.mkdir(root, { recursive: true });
    assert((await run(label + "-extract", "tar", ["-xf", archive, "-C", root])).success);
    return root;
  };
  const roots = ["_site-student", "tasks/_output/student", "slides/_output/student"];
  const saveOutputs = async (label: string) => {
    const destination = join(output, label, "outputs");
    await Deno.mkdir(destination, { recursive: true });
    for (const path of [...roots, ...roots.map((path) => path.replaceAll("student", "full"))]) {
      try {
        await copyTree(join(renderRoot, path), join(destination, path));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return destination;
  };
  const dynamicFiles = ["sitemap.xml"];
  const compare = async (label: string, left: string, right: string, paths: string[]) => {
    const comparisons = [];
    for (const path of paths) {
      const comparison = await compareStrictTrees(
        join(left, path),
        join(right, path),
        dynamicFiles,
      );
      comparisons.push({ path, ...comparison });
    }
    await json(join(output, label + ".comparison.json"), comparisons);
    assert(comparisons.every((c) => c.equivalent), `${label}: outputs различаются`);
    assert(comparisons.some((c) => c.html > 0), `${label}: нет HTML`);
    gates.push({ label, status: "PASS", comparisons });
  };
  const monitored = async (
    label: string,
    root: string,
    mode: string,
    args: string[],
    cwd = ".",
  ) => {
    const reports = join(output, label, "reports");
    const result = await run(label, Deno.execPath(), [
      ...flags,
      "render",
      "--perf-mode",
      mode,
      "--perf-output",
      reports,
      ...args,
    ], join(root, cwd));
    assert(result.success, `${label}: ${decode(result.stderr)}`);
    const entries = await Array.fromAsync(Deno.readDir(reports));
    assert.equal(entries.length, 1);
    const directory = join(reports, entries[0].name);
    const record = validateRunRecord(
      JSON.parse(await Deno.readTextFile(join(directory, "run.json"))),
    );
    assert.equal(completedNative({ record, directory }).code, 0);
    assert.equal(record.dataValid, true);
    if (mode !== "off") {
      const normalized = await normalizeRun(directory);
      assert(normalized.dataValid);
      assert(Object.keys(normalized.executors).length > 0);
      gates.push({
        label,
        status: "PASS",
        runId: record.runId,
        outcome: record.completion.native,
        quality: normalized.quality,
        executors: Object.keys(normalized.executors).length,
        events: normalized.events.length,
      });
    } else {gates.push({
        label,
        status: "PASS",
        runId: record.runId,
        outcome: record.completion.native,
      });}
    return { directory, record };
  };
  let studentNative = "";
  let completed = false;
  try {
    for (const profile of ["student", "full"]) {
      let native = await makeCopy("root-native-" + profile);
      assert(
        (await run("root-native-" + profile, quarto, ["render", "--profile", profile], native))
          .success,
      );
      native = await saveOutputs("root-native-" + profile);
      let off = await makeCopy("root-off-" + profile);
      await monitored("root-off-" + profile, off, "off", ["--profile", profile]);
      off = await saveOutputs("root-off-" + profile);
      await compare(
        "root-native-off-" + profile,
        native,
        off,
        roots.map((p) => p.replaceAll("student", profile)),
      );
      if (profile === "student") studentNative = native;
    }
    const summary = await makeCopy("root-summary-student");
    const summaryRun = await monitored("root-summary-student", summary, "summary", [
      "--profile",
      "student",
    ]);
    const summaryProcesses = await files(join(summaryRun.directory, "processes"));
    assert(summaryProcesses.length > 2, "Publisher nested процессы отсутствуют");
    const processes = await Promise.all(
      summaryProcesses.filter((p) => p.endsWith(".json")).map(async (p) =>
        JSON.parse(await Deno.readTextFile(p))
      ),
    );
    for (const nested of ["tasks", "slides"]) {
      assert(
        processes.some((p) =>
          p.exit_code === 0 && p.expectation?.executed && p.cwd === join(summary, nested)
        ),
        `Не подтверждено исполнение nested ${nested}`,
      );
    }
    await json(join(output, "root-summary-nested-contexts.json"), processes);

    await compare(
      "root-native-summary-student",
      studentNative,
      await saveOutputs("root-summary-student"),
      roots,
    );
    for (
      const selection of [
        { label: "cwd-slides", cwd: "slides", args: [], outputs: [roots[2]] },
        { label: "target-slides-directory", cwd: ".", args: ["slides"], outputs: [roots[2]] },
        { label: "target-slides-file", cwd: ".", args: ["slides/index.qmd"], outputs: [roots[2]] },
        { label: "cwd-tasks", cwd: "tasks", args: [], outputs: [roots[1]] },
        {
          label: "cwd-tasks-projects",
          cwd: "tasks/projects",
          args: ["../index.qmd"],
          outputs: [roots[1]],
        },
      ]
    ) {
      let native = await makeCopy(selection.label + "-native");
      assert(
        (await run(selection.label + "-native", quarto, [
          "render",
          ...selection.args,
          "--profile",
          "student",
        ], join(native, selection.cwd))).success,
      );
      native = await saveOutputs(selection.label + "-native");
      const monitoredRoot = await makeCopy(selection.label + "-summary");
      await monitored(selection.label + "-summary", monitoredRoot, "summary", [
        ...selection.args,
        "--profile",
        "student",
      ], selection.cwd);
      await compare(
        selection.label,
        native,
        await saveOutputs(selection.label + "-summary"),
        selection.outputs,
      );
    }
    const cpu = await makeCopy("slides-cpu");
    const cpuRun = await monitored("slides-cpu", cpu, "cpu", [
      "slides/index.qmd",
      "--profile",
      "student",
      "--to",
      "revealjs",
    ]);
    assert(
      (await files(join(cpuRun.directory, "profiles"))).some((p) => p.endsWith(".cpuprofile")),
      "CPU profile отсутствует",
    );
    await compare("slides-native-cpu", studentNative, await saveOutputs("slides-cpu"), [roots[2]]);

    const sourceSelection: SourceSelection = {
      repository: "BSU-RFCT-Afonenko-Courses/Java",
      sourceKind: "local-candidate",
      remoteRef: "HEAD",
      sha: sourceSHA,
      fetchedAt: new Date().toISOString(),
      checkoutPath: project,
    };
    for (const replacement of [false, true]) {
      const label = replacement ? "explicit-replacement" : "isolated-trace";
      const root = await makeCopy(label);
      const manifest: SourceManifest = {
        schema_version: 2,
        projectSource: sourceSelection.repository,
        replacements: [],
        experimentId: crypto.randomUUID(),
        sources: [sourceSelection],
        packages: [],
        runtime: {},
      };
      if (replacement) {
        assert.equal(await git(replacementOwner, ["status", "--porcelain"]), "");
        const ownerSHA = await git(replacementOwner, ["rev-parse", "HEAD"]);
        const owner: SourceSelection = {
          ...sourceSelection,
          repository: "Afonenko-Course-Tools/quarto-reference-catalog",
          sha: ownerSHA,
          checkoutPath: replacementOwner,
        };
        manifest.sources.push(owner);
        manifest.replacements = [{
          repository: owner.repository,
          extensionId: "reference-catalog",
          destinations: ["tasks/_extensions/Afonenko-Course-Tools/reference-catalog"],
        }];
        manifest.packages = await installPackages(root, manifest.sources, manifest.replacements);
        assert.equal(manifest.packages.length, 1);
      }
      const scenario = {
        id: label,
        cwd: ".",
        executable: quarto,
        args: ["render", "--profile", "student"],
        cachePolicy: "repeat-render" as const,
        mode: "trace" as const,
        scope: {
          modules: [
            "tasks/_extensions/Afonenko-Course-Tools/reference-catalog/infrastructure/publish.ts",
            "tasks/_extensions/Afonenko-Course-Tools/course-core/pedagogy/collect.lua",
          ],
          extensions: [
            "course-core",
            "course-site",
            "reference-catalog",
            "project-download",
            "course-prairielearn",
          ],
          strict: true,
        },
        resources: { wall: true, cpu: true, peakRss: true },
      };
      const prepared = { root, variant: "candidate" as const, manifest };
      const diagnostic = await prepareDiagnostic(
        scenario,
        prepared,
        join(output, label, "diagnostic"),
        quarto,
      );
      const startUTC = new Date().toISOString();
      const result = await executeScenario(scenario, prepared, "trace", {
        abortSignal,
        outputRoot: join(output, label, "runs"),
        diagnosticEnv: diagnostic.env,
        preparedScripts: diagnostic.preparedScripts,
        coverage: diagnostic.coverage,
      });
      const native = completedNative(result);
      const normalized = await normalizeRun(result.directory);
      const recorded = [
        ...new Set(
          normalized.events.map(operationAttribution).filter((a) =>
            a.extension_attribution === "recorded"
          ).map((a) => a.extension_id),
        ),
      ];
      const executedSymbols = diagnostic.coverage.ts.flatMap((entry) => {
        const e = entry as { symbols: { id: string }[] };
        return e.symbols.map((s) => s.id).filter((id) =>
          normalized.events.some((event) => event.operation_id === id && event.event === "begin")
        );
      });
      const diagnosticReport = {
        label,
        startUTC,
        endUTC: new Date().toISOString(),
        environment,
        scenario,
        manifest,
        result,
        quality: normalized.quality,
        executors: normalized.executors,
        recorded,
        executedSymbols,
        coverage: diagnostic.coverage,
      };
      await json(join(output, label + ".diagnostic.json"), diagnosticReport);
      assert.equal(native.code, 0);
      assert(normalized.dataValid);
      assert(normalized.events.length > 0);
      assert(executedSymbols.length > 0, "Выбранные TS функции не исполнялись");
      assert(recorded.includes("reference-catalog"), "QRC execution context не записан");
      gates.push({
        label,
        status: "PASS",
        runId: result.record.runId,
        events: normalized.events.length,
        executors: Object.keys(normalized.executors).length,
        recorded,
        executedSymbols,
        replacements: manifest.replacements,
        packages: manifest.packages,
      });
      await compare(label + "-outputs", studentNative, await saveOutputs(label), roots);
    }
    const fixture = join(renderParent, "small-fixture");
    await Deno.mkdir(fixture);
    await Deno.writeTextFile(
      join(fixture, "_quarto.yml"),
      "project:\n  type: default\nformat: html\n",
    );
    await Deno.writeTextFile(
      join(fixture, "_quarto-arbitrary.yml"),
      "metadata:\n  fixture: arbitrary\n",
    );
    await Deno.writeTextFile(
      join(fixture, "index.qmd"),
      "---\ntitle: Small fixture\n---\n\nPlain content without extension markup.\n",
    );
    const plain = await monitored(
      "fixture-no-git-no-markup-arbitrary-profile",
      fixture,
      "summary",
      ["index.qmd", "--profile", "arbitrary"],
    );
    assert.equal(plain.record.git, null);
    assert.match(await Deno.readTextFile(join(fixture, "index.html")), /Plain content/);
    const negative = await run("fixture-invalid-quality-and-signals", Deno.execPath(), [
      "test",
      "-A",
      "tests/runner/storage-cli.test.ts",
      "tests/analysis/quality.test.ts",
    ], app);
    assert(negative.success, "Маленькие invalid/failure/signal fixtures не прошли");
    gates.push({ label: "fixture-invalid-quality-and-signals", status: "PASS" });
    await copyTree(fixture, join(output, "small-fixture"));
    completed = true;
  } finally {
    const evidence = {
      schema_version: 1,
      status: completed ? "PASS" : "FAIL",
      executionHEAD,
      sourceSHA,
      renderRoot,
      tools,
      targets: [".", "tasks", "slides"],
      dynamicFiles,
      commands,
      gates,
      limits: [
        "Cloud VM не входит в выбранный Java; coverageComplete не заявляется",
        "Часы Lua CPU и TS wall раздельны; результаты относятся к исполненным process contexts",
      ],
    };
    await json(join(output, "validation.json"), evidence);
    await Deno.remove(renderParent, { recursive: true });
  }
}

if (import.meta.main) {
  const { project, output, replacementOwner } = parseJavaArgs(Deno.args);
  await checkJava(project, output, replacementOwner);
}
