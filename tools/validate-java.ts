// Строгое сравнение сохранившихся outputs; запускать после завершения benchmark/diagnostics.
import { dirname, join, resolve } from "node:path";
import { loadOwnerNormalizer } from "./owner-normalizer.ts";
import { validateConfig } from "../src/config/validate.ts";
import { compareOutputs } from "../src/analysis/outputs.ts";
import { importSourceManifest } from "../src/config/types.ts";
import { files } from "../src/sources/snapshot.ts";
const workspace = resolve(Deno.args[0]), upstreamWorkspace = resolve(Deno.args[1]);
const config = validateConfig(
  JSON.parse(await Deno.readTextFile(new URL("../scenarios/java.json", import.meta.url))),
);
const normalizer = await loadOwnerNormalizer(
  Deno.args[2] ?? join(workspace, "candidate.manifest.json"),
);
const canonicalizeMetadata = normalizer.normalizeHtml;
type Build = {
  runId: string;
  scenario: string;
  mode: string;
  variant: string;
  cwd: string;
  outputDirectory: string;
  buildExitCode: number;
  dataValid: boolean;
  manifest: { sources: { repository: string; sha: string }[] };
};
async function findRun(
  root: string,
  scenario: string,
  variant: string,
  mode: string,
): Promise<Build> {
  const matches: { meta: Build; modified: number }[] = [];
  for await (const entry of Deno.readDir(join(root, "runs"))) {
    if (!entry.isDirectory) continue;
    const path = join(root, "runs", entry.name, "run.json");
    try {
      const meta: Build = JSON.parse(await Deno.readTextFile(path));
      if (
        meta.scenario === scenario && meta.variant === variant && meta.mode === mode &&
        !meta.buildExitCode && meta.dataValid
      ) {
        meta.manifest = importSourceManifest(
          JSON.parse(await Deno.readTextFile(join(dirname(path), "manifest.json"))),
          true,
        );
        matches.push({ meta, modified: (await Deno.stat(path)).mtime!.getTime() });
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  const run = matches.sort((a, b) => b.modified - a.modified)[0]?.meta;
  if (!run) throw new Error(`Нет успешного run: ${scenario}/${variant}/${mode}`);
  return run;
}
const comparisons: unknown[] = [], leaks: string[] = [];
let equivalent = true;
async function exists(path: string) {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}
async function compareBuilds(a: Build, b: Build, label: string) {
  const scenario = config.scenarios.find((s) => s.id === b.scenario)!;
  const root = (build: Build) => scenario.cwd === "." ? build.cwd : dirname(build.cwd);
  const checks = [];
  const paths = b.scenario === "java-pl-export"
    ? ["pl-native"]
    : (config.cleanPaths ?? []).filter((p) =>
      p.endsWith(b.scenario === "java-full-full" ? "full" : "student")
    );
  for (const path of paths) {
    const left = b.scenario === "java-pl-export"
      ? join(a.outputDirectory, path)
      : join(root(a), path);
    const right = b.scenario === "java-pl-export"
      ? join(b.outputDirectory, path)
      : join(root(b), path);
    const hasA = await exists(left), hasB = await exists(right);
    if (!hasA && !hasB) continue;
    const result = hasA && hasB
      ? await compareOutputs(left, right, {
        outputPolicy: config.outputPolicy,
        leftSourceRoot: root(a),
        rightSourceRoot: root(b),
        normalizeHtml: canonicalizeMetadata,
      })
      : { equivalent: false, differences: ["Output directory отсутствует в одном варианте"] };
    checks.push({ path, ...result });
    equivalent &&= result.equivalent;
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
  comparisons.push({ label, leftRunId: a.runId, rightRunId: b.runId, checks });
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
  equivalent: equivalent && !leaks.length,
  ownerNormalizer: normalizer.receipt,
  normalization:
    "QRC owner metadata.ts (candidate SHA) + historical Core exercise attribute order; values/content/ZIP bytes strict",
  upstreamProvenance: "previous experiment, identical immutable upstream source set",
};
await Deno.writeTextFile(
  join(workspace, "outputs-validation.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
if (!result.equivalent) Deno.exit(4);
