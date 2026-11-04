// Проверка состава и выбранного содержимого outputs после benchmark/diagnostics.
import { dirname, join, resolve } from "node:path";
import { validateConfig } from "../src/config/validate.ts";
import { compareOutputs } from "../src/analysis/outputs.ts";
import { importSourceManifest, type ReportSourceManifest } from "../src/config/types.ts";
import { type PublishedRun, validateRunRecord } from "../src/report/types.ts";
import { files } from "../src/sources/files.ts";
const workspace = resolve(Deno.args[0]), upstreamWorkspace = resolve(Deno.args[1]);
const config = validateConfig(
  JSON.parse(await Deno.readTextFile(new URL("../scenarios/java.json", import.meta.url))),
);
async function findRun(
  root: string,
  scenario: string,
  variant: string,
  mode: string,
): Promise<PublishedRun & { manifest: ReportSourceManifest }> {
  const matches: {
    publication: PublishedRun & { manifest: ReportSourceManifest };
    modified: number;
  }[] = [];
  for await (const entry of Deno.readDir(join(root, "runs"))) {
    if (!entry.isDirectory) continue;
    const path = join(root, "runs", entry.name, "run.json");
    try {
      const meta = validateRunRecord(JSON.parse(await Deno.readTextFile(path)));
      if (
        meta.scenario === scenario && meta.variant === variant && meta.request.mode === mode &&
        meta.completion.kind === "complete" && meta.completion.native.code === 0 &&
        meta.completion.native.signal === null && meta.dataValid
      ) {
        const manifest = importSourceManifest(
          JSON.parse(await Deno.readTextFile(join(dirname(path), "manifest.json"))),
          true,
        );
        matches.push({
          publication: { record: meta, directory: dirname(path), manifest },
          modified: (await Deno.stat(path)).mtime!.getTime(),
        });
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  const run = matches.sort((a, b) => b.modified - a.modified)[0]?.publication;
  if (!run) throw new Error(`Нет успешного run: ${scenario}/${variant}/${mode}`);
  return run;
}
const comparisons: unknown[] = [], leaks: string[] = [];
let checkedContentEqual = true;
async function exists(path: string) {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}
async function compareBuilds(a: PublishedRun, b: PublishedRun, label: string) {
  const scenario = config.scenarios.find((s) => s.id === b.record.scenario)!;
  const root = (build: PublishedRun) =>
    scenario.cwd === "." ? build.record.request.cwd : dirname(build.record.request.cwd);
  const checks = [];
  const paths = b.record.scenario === "java-pl-export"
    ? ["pl-native"]
    : (config.cleanPaths ?? []).filter((p) =>
      p.endsWith(b.record.scenario === "java-full-full" ? "full" : "student")
    );
  for (const path of paths) {
    const left = b.record.scenario === "java-pl-export"
      ? join(a.directory, path)
      : join(root(a), path);
    const right = b.record.scenario === "java-pl-export"
      ? join(b.directory, path)
      : join(root(b), path);
    const hasA = await exists(left), hasB = await exists(right);
    if (!hasA && !hasB) continue;
    const result = hasA && hasB
      ? await compareOutputs(left, right, {
        outputPolicy: config.outputPolicy,
      })
      : {
        checkedContentEqual: false,
        htmlBytesCompared: config.outputPolicy === "strict",
        differences: ["Output directory отсутствует в одном варианте"],
      };
    checks.push({ path, ...result });
    checkedContentEqual &&= result.checkedContentEqual;
    if (hasB) {
      for (const file of await files(right)) {
        if (
          /\.(?:cpuprofile|jsonl)$|\/(?:tool-status|scope|run)\.json$|\/resources\.txt$|\/agents\/(?:ts|lua)\//
            .test(file)
        ) leaks.push(file);
        if (file.endsWith(".zip")) {
          const out = await new Deno.Command("unzip", {
            args: ["-Z1", file],
            stdout: "piped",
            stderr: "piped",
          }).output();
          if (!out.success) throw new Error("Невалидный ZIP");
          for (const name of new TextDecoder().decode(out.stdout).split("\n")) {
            if (/\.(?:cpuprofile|jsonl)$|(?:^|\/)agents\/(?:ts|lua)\//.test(name)) {
              leaks.push(file + ":" + name);
            }
          }
        }
      }
    }
  }
  if (!checks.length) throw new Error("Сравнение без outputs");
  comparisons.push({ label, leftRunId: a.record.runId, rightRunId: b.record.runId, checks });
}
for (const profile of ["student", "full"]) {
  const id = "java-full-" + profile;
  const upstream = await findRun(upstreamWorkspace, id, "upstream", "off");
  const control = await findRun(
    Deno.args[3] ? resolve(Deno.args[3]) : workspace,
    id,
    "clean-control",
    "off",
  );
  const candidate = await findRun(workspace, id, "candidate", "off");
  const summary = await findRun(workspace, id, "candidate", "summary");
  const frozen = importSourceManifest(
    JSON.parse(await Deno.readTextFile(join(workspace, "upstream.manifest.json"))),
    true,
  );
  for (const source of frozen.sources) {
    if (
      !upstream.manifest.sources.some((s) =>
        s.repository === source.repository && s.sha === source.sha
      )
    ) throw new Error("Upstream из другого source set");
  }
  const frozenControl = importSourceManifest(
    JSON.parse(
      await Deno.readTextFile(join(workspace, "clean-control.manifest.json")),
    ),
    true,
  );
  for (const source of frozenControl.sources) {
    if (
      !control.manifest.sources.some((s) =>
        s.repository === source.repository && s.sha === source.sha
      )
    ) throw new Error("Control из другого source set");
  }
  await compareBuilds(upstream, control, id + ":upstream-control");
  await compareBuilds(control, candidate, id + ":control-candidate");
  await compareBuilds(candidate, summary, id + ":off-summary");
}
for (const id of ["java-ast-document", "java-ts-publication", "java-pl-export"]) {
  const mode = id === "java-pl-export" ? "summary" : "trace";
  await compareBuilds(
    await findRun(workspace, id, "candidate", "off"),
    await findRun(workspace, id, "candidate", mode),
    id + ":off-" + mode,
  );
}
await compareBuilds(
  await findRun(workspace, "java-ts-publication", "candidate", "off"),
  await findRun(workspace, "java-ts-publication", "candidate", "cpu"),
  "java-ts-publication:off-cpu",
);
const result = {
  comparisons,
  leaks,
  checkedContentEqual: checkedContentEqual && !leaks.length,
  htmlBytesCompared: config.outputPolicy === "strict",
  upstreamProvenance: "previous experiment, identical immutable upstream source set",
};
await Deno.writeTextFile(
  join(workspace, "outputs-validation.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
if (!result.checkedContentEqual) Deno.exit(4);
