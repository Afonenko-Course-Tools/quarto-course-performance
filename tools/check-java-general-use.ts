import { strict as assert } from "node:assert";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { files, hashBytes, hashFile, treeHash } from "../src/sources/snapshot.ts";
import { prepareDiagnostic } from "../src/runner/diagnostic.ts";
import { executeScenario } from "../src/runner/execute.ts";
import { normalizeRun, operationAttribution } from "../src/analysis/normalize.ts";
import { installPackages } from "../src/sources/packages.ts";
import type { SourceManifest, SourceReceipt } from "../src/config/types.ts";

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
  const inventory = async (root: string) =>
    Object.fromEntries(
      await Promise.all((await files(root)).map(async (path) => [
        relative(root, path),
        await hashFile(path),
      ])),
    );
  const a = await inventory(left), b = await inventory(right);
  const differences: { path: string; left: string | null; right: string | null }[] = [];
  const dynamic: typeof differences = [];
  for (const path of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[path] === b[path]) continue;
    const item = { path, left: a[path] ?? null, right: b[path] ?? null };
    // Исключение не разрешает появление/исчезновение файла.
    (exceptions.includes(path) && a[path] && b[path] ? dynamic : differences).push(item);
  }
  return {
    equivalent: differences.length === 0,
    files: Object.keys(a).length,
    html: Object.keys(a).filter((p) => p.endsWith(".html")).length,
    zip: Object.keys(a).filter((p) => p.endsWith(".zip")).length,
    differences,
    dynamic,
    exceptions,
  };
}

export async function checkJava(project: string, output: string, replacementOwner?: string) {
  assert(isAbsolute(project) && isAbsolute(output), "--project/--output требуют абсолютные пути");
  assert(!output.startsWith(project + "/"), "Evidence должен находиться вне source");
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
    const receipt = {
      label,
      executable,
      argv: args,
      cwd,
      environment,
      startUTC,
      endUTC: new Date().toISOString(),
      exit: result.code,
      signal: result.signal,
      stdoutSHA256: await hashBytes(result.stdout),
      stderrSHA256: await hashBytes(result.stderr),
    };
    await json(join(output, label + ".receipt.json"), receipt);
    commands.push(receipt);
    console.log(`${label}: exit ${result.code}`);
    return result;
  };
  const git = async (path: string, args: string[]) => {
    const result = await new Deno.Command("git", {
      args: ["-C", path, ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, decode(result.stderr));
    return decode(result.stdout).trim();
  };
  const sourceSHA = await git(project, ["rev-parse", "HEAD"]);
  assert.equal(await git(project, ["status", "--porcelain"]), "", "Source должен быть clean");
  const sourceBefore = await treeHash(project);
  const sourceFiles = Object.fromEntries(
    await Promise.all((await files(project)).map(async (p) => [
      relative(project, p),
      await hashFile(p),
    ])),
  );
  const tracked = await git(project, ["ls-tree", "-r", "HEAD"]);
  await Deno.writeTextFile(join(output, "source-file-oids.txt"), tracked + "\n");
  await json(join(output, "source-inventory.json"), sourceFiles);
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
  const executionFiles = Object.fromEntries(
    await Promise.all(
      (await files(join(app, "src"))).concat(
        await files(join(app, "bridge")),
        await files(join(app, "tools")),
        join(app, "deno.json"),
        join(app, "deno.lock"),
        join(app, "docs/operation-registry.json"),
      ).map(async (p) => [relative(app, p), await hashFile(p)]),
    ),
  );
  await json(join(output, "execution-source.json"), { executionHEAD, files: executionFiles });
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
  const makeCopy = async (label: string) => {
    const root = join(output, label, "course");
    await Deno.mkdir(root, { recursive: true });
    assert((await run(label + "-extract", "tar", ["-xf", archive, "-C", root])).success);
    return root;
  };
  const roots = ["_site-student", "tasks/_output/student", "slides/_output/student"];
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
    const record = JSON.parse(await Deno.readTextFile(join(directory, "run.json")));
    assert.equal(record.outcome.code, 0);
    assert.equal(record.dataValid, true);
    if (mode !== "off") {
      const normalized = await normalizeRun(directory);
      assert(normalized.dataValid);
      assert(Object.keys(normalized.executors).length > 0);
      gates.push({
        label,
        status: "PASS",
        runId: record.runId,
        outcome: record.outcome,
        quality: normalized.quality,
        executors: Object.keys(normalized.executors).length,
        events: normalized.events.length,
      });
    } else gates.push({ label, status: "PASS", runId: record.runId, outcome: record.outcome });
    return { directory, record };
  };
  let studentNative = "";
  let completed = false;
  try {
    for (const profile of ["student", "full"]) {
      const native = await makeCopy("root-native-" + profile);
      assert(
        (await run("root-native-" + profile, quarto, ["render", "--profile", profile], native))
          .success,
      );
      const off = await makeCopy("root-off-" + profile);
      await monitored("root-off-" + profile, off, "off", ["--profile", profile]);
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

    await compare("root-native-summary-student", studentNative, summary, roots);
    for (
      const selection of [
        { label: "cwd-slides", cwd: "slides", args: [], outputs: [roots[2]] },
        { label: "target-slides-directory", cwd: ".", args: ["slides"], outputs: [roots[2]] },
        { label: "target-slides-file", cwd: ".", args: ["slides/index.qmd"], outputs: [roots[2]] },
        { label: "cwd-tasks", cwd: "tasks", args: [], outputs: [roots[1]] },
      ]
    ) {
      const native = await makeCopy(selection.label + "-native");
      assert(
        (await run(selection.label + "-native", quarto, [
          "render",
          ...selection.args,
          "--profile",
          "student",
        ], join(native, selection.cwd))).success,
      );
      const monitoredRoot = await makeCopy(selection.label + "-summary");
      await monitored(selection.label + "-summary", monitoredRoot, "summary", [
        ...selection.args,
        "--profile",
        "student",
      ], selection.cwd);
      await compare(selection.label, native, monitoredRoot, selection.outputs);
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
    await compare("slides-native-cpu", studentNative, cpu, [roots[2]]);

    const sourceReceipt: SourceReceipt = {
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
        projectSource: sourceReceipt.repository,
        replacements: [],
        experimentId: crypto.randomUUID(),
        sources: [sourceReceipt],
        packages: [],
        runtime: {},
      };
      if (replacement) {
        assert(
          replacementOwner && isAbsolute(replacementOwner),
          "Для actual replacement нужен --replacement-owner /absolute/owner-checkout",
        );
        assert.equal(await git(replacementOwner, ["status", "--porcelain"]), "");
        const ownerSHA = await git(replacementOwner, ["rev-parse", "HEAD"]);
        const owner: SourceReceipt = {
          ...sourceReceipt,
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
        await json(join(output, label + ".owner-oids.json"), {
          ownerSHA,
          files: await git(replacementOwner, [
            "ls-tree",
            "-r",
            "HEAD",
            "--",
            "_extensions/reference-catalog",
          ]),
        });
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
        outputRoot: join(output, label, "runs"),
        diagnosticEnv: diagnostic.env,
        preparation: diagnostic.preparation,
        coverage: diagnostic.coverage,
      });
      const normalized = await normalizeRun(result.outputDirectory);
      const raw = Object.fromEntries(
        await Promise.all(
          (await files(result.outputDirectory)).map(async (
            p,
          ) => [relative(result.outputDirectory, p), await hashFile(p)]),
        ),
      );
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
      const proof = {
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
        raw,
        coverage: diagnostic.coverage,
      };
      await json(join(output, label + ".proof.json"), proof);
      assert.equal(result.buildExitCode, 0);
      assert(normalized.dataValid);
      assert(normalized.events.length > 0);
      assert(executedSymbols.length > 0, "Выбранные TS функции не исполнялись");
      assert(recorded.includes("reference-catalog"), "QRC execution context не записан");
      gates.push({
        label,
        status: "PASS",
        runId: result.runId,
        events: normalized.events.length,
        executors: Object.keys(normalized.executors).length,
        recorded,
        executedSymbols,
        replacements: manifest.replacements,
        packages: manifest.packages,
      });
      await compare(label + "-outputs", studentNative, root, roots);
    }
    const fixture = join(output, "small-fixture");
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
    completed = true;
  } finally {
    const sourceAfter = await treeHash(project);
    const sourceUnchanged = sourceBefore === sourceAfter &&
      sourceSHA === await git(project, ["rev-parse", "HEAD"]);
    const evidence = {
      schema_version: 1,
      status: completed && sourceUnchanged ? "PASS" : "FAIL",
      executionHEAD,
      sourceSHA,
      sourceBefore,
      sourceAfter,
      sourceUnchanged,
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
    assert(sourceUnchanged, "Source Java изменился во время проверки");
  }
}

if (import.meta.main) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < Deno.args.length; i += 2) {
    const key = Deno.args[i], value = Deno.args[i + 1];
    if (!["--project", "--output", "--replacement-owner"].includes(key) || !value || flags[key]) {
      throw new Error(
        "check-java-general-use.ts --project /absolute/checkout --output /absolute/new-evidence --replacement-owner /absolute/owner",
      );
    }
    flags[key] = value;
  }
  await checkJava(flags["--project"], flags["--output"], flags["--replacement-owner"]);
}
