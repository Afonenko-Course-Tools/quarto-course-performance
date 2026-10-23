import { strict as assert } from "node:assert";
import { join, relative } from "node:path";
import { finalizeRun, prepareRunStorage } from "../../src/runner/storage.ts";
import { record } from "../report/fixture.ts";
import type { NativeRenderRequest } from "../../src/report/types.ts";

Deno.test("storage stages externally and restores only current run after Quarto removes scratch", async () => {
  const root = await Deno.makeTempDir();
  let stage = "";
  try {
    const request: NativeRenderRequest = {
      cwd: root,
      quarto: "quarto",
      mode: "off",
      nativeArgv: [],
    };
    const paths = await prepareRunStorage(request, { projectRoot: root, kind: "standalone" });
    stage = paths.stagingDirectory;
    assert(relative(root, stage).startsWith(".."));
    await Deno.mkdir(join(root, ".quarto/foreign"), { recursive: true });
    await Deno.writeTextFile(join(stage, "stdout.log"), "current");
    await Deno.writeTextFile(join(stage, "stderr.log"), "");
    await Deno.mkdir(join(stage, "events"));
    await Deno.writeTextFile(join(stage, "events/raw.jsonl"), "raw");
    await Deno.remove(join(root, ".quarto"), { recursive: true });
    const output = await finalizeRun(paths, record(stage, paths.runId));
    assert.equal(output, join(root, ".quarto/course-perf/runs", paths.runId));
    assert.equal(await Deno.readTextFile(join(output, "stdout.log")), "current");
    assert.equal(await Deno.readTextFile(join(output, "events/raw.jsonl")), "raw");
    await Deno.stat(join(output, "report.md"));
    await assert.rejects(() => Deno.stat(join(root, ".quarto/foreign")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
    if (stage) await Deno.remove(stage, { recursive: true }).catch(() => {});
  }
});

Deno.test("storage resolves output from original cwd and isolates simultaneous projects and runs", async () => {
  const root = await Deno.makeTempDir();
  const stages: string[] = [];
  try {
    await Deno.mkdir(join(root, "project"));
    await Deno.mkdir(join(root, "other"));
    const request: NativeRenderRequest = {
      cwd: root,
      quarto: "quarto",
      mode: "off",
      nativeArgv: [],
      outputParent: "reports",
    };
    const paths = await Promise.all(
      ["project", "other"].map((project) =>
        prepareRunStorage(request, { projectRoot: join(root, project), kind: "project" })
      ),
    );
    for (const p of paths) {
      stages.push(p.stagingDirectory);
      assert.equal(p.finalDirectory, join(root, "reports", p.runId));
    }
    assert.notEqual(paths[0].runId, paths[1].runId);
    assert.notEqual(paths[0].stagingDirectory, paths[1].stagingDirectory);
    await Deno.mkdir(paths[0].finalDirectory, { recursive: true });
    await Deno.writeTextFile(join(paths[0].finalDirectory, "keep"), "existing");
    await assert.rejects(
      () => finalizeRun(paths[0], record(paths[0].stagingDirectory, paths[0].runId)),
      new RegExp(paths[0].stagingDirectory),
    );
    assert.equal(await Deno.readTextFile(join(paths[0].finalDirectory, "keep")), "existing");
    await Deno.stat(join(paths[0].stagingDirectory, "report.md"));
  } finally {
    await Deno.remove(root, { recursive: true });
    for (const s of stages) await Deno.remove(s, { recursive: true }).catch(() => {});
  }
});

Deno.test("storage refuses file, symlink and unwritable parents without touching their contents", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(root, "file"), "keep");
    await Deno.mkdir(join(root, "real"));
    await Deno.symlink(join(root, "real"), join(root, "link"));
    for (const outputParent of ["file", "link/sub", "/proc/course-perf-forbidden"]) {
      await assert.rejects(() =>
        prepareRunStorage({
          cwd: root,
          quarto: "quarto",
          nativeArgv: [],
          mode: "off",
          outputParent,
        }, { projectRoot: root, kind: "standalone" })
      );
    }
    assert.equal(await Deno.readTextFile(join(root, "file")), "keep");
    assert.deepEqual([...Deno.readDirSync(join(root, "real"))], []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("failed finalize keeps complete staging and rejects substituted symlink parents", async () => {
  const root = await Deno.makeTempDir();
  let stage = "";
  try {
    const paths = await prepareRunStorage({
      cwd: root,
      quarto: "quarto",
      nativeArgv: [],
      mode: "off",
      outputParent: "out",
    }, { projectRoot: root, kind: "standalone" });
    stage = paths.stagingDirectory;
    await Deno.remove(join(root, "out"), { recursive: true });
    await Deno.mkdir(join(root, "foreign"));
    await Deno.symlink(join(root, "foreign"), join(root, "out"));
    await assert.rejects(() => finalizeRun(paths, record(stage, paths.runId)), new RegExp(stage));
    await Deno.stat(join(stage, "run.json"));
    await Deno.stat(join(stage, "report.md"));
    assert.deepEqual([...Deno.readDirSync(join(root, "foreign"))], []);
  } finally {
    await Deno.remove(root, { recursive: true });
    if (stage) await Deno.remove(stage, { recursive: true }).catch(() => {});
  }
});
Deno.test("finalize refuses symlink report collisions before writing outside staging", async () => {
  const root = await Deno.makeTempDir();
  let stage = "";
  try {
    const paths = await prepareRunStorage({
      cwd: root,
      quarto: "quarto",
      mode: "off",
      nativeArgv: [],
    }, { projectRoot: root, kind: "standalone" });
    stage = paths.stagingDirectory;
    await Deno.writeTextFile(join(root, "keep"), "original");
    await Deno.symlink(join(root, "keep"), join(stage, "run.json"));
    await assert.rejects(() => finalizeRun(paths, record(stage, paths.runId)), new RegExp(stage));
    assert.equal(await Deno.readTextFile(join(root, "keep")), "original");
  } finally {
    await Deno.remove(root, { recursive: true });
    if (stage) await Deno.remove(stage, { recursive: true }).catch(() => {});
  }
});
Deno.test("storage remains external when ambient temporary directory is inside project", async () => {
  const root = await Deno.makeTempDir();
  const previous = Deno.env.get("TMPDIR");
  let stage = "";
  try {
    Deno.env.set("TMPDIR", root);
    const paths = await prepareRunStorage({
      cwd: root,
      quarto: "quarto",
      mode: "off",
      nativeArgv: [],
    }, { projectRoot: root, kind: "standalone" });
    stage = paths.stagingDirectory;
    assert(relative(root, stage).startsWith(".."));
  } finally {
    if (previous === undefined) Deno.env.delete("TMPDIR");
    else Deno.env.set("TMPDIR", previous);
    await Deno.remove(root, { recursive: true });
    if (stage) await Deno.remove(stage, { recursive: true }).catch(() => {});
  }
});
Deno.test("resource exclusions must cover the whole output, not only one artifact kind", async () => {
  const root = await Deno.makeTempDir();
  let stage = "";
  try {
    const request: NativeRenderRequest = {
      cwd: root,
      quarto: "quarto",
      mode: "off",
      nativeArgv: [],
      outputParent: "reports",
    };
    await assert.rejects(
      () =>
        prepareRunStorage(request, {
          projectRoot: root,
          kind: "project",
          resources: ["**", "!reports/*/events/**"],
        }),
      /resources/,
    );
    const allowed = await prepareRunStorage(request, {
      projectRoot: root,
      kind: "project",
      resources: ["**", "!reports/**"],
    });
    stage = allowed.stagingDirectory;
  } finally {
    await Deno.remove(root, { recursive: true });
    if (stage) await Deno.remove(stage, { recursive: true }).catch(() => {});
  }
});
Deno.test("resource overlap detects artifact globs and explicitly included external directories", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "project"));
    for (
      const [outputParent, resources] of [["reports", ["reports/**/*.log"]], ["../external", [
        "../external/**",
      ]]] as const
    ) {
      await assert.rejects(
        () =>
          prepareRunStorage({
            cwd: join(root, "project"),
            quarto: "quarto",
            mode: "off",
            nativeArgv: [],
            outputParent,
          }, { projectRoot: join(root, "project"), kind: "project", resources: [...resources] }),
        /resources/,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("standalone directly in system temp still receives external staging", async () => {
  const output = await Deno.makeTempDir();
  let stage = "";
  try {
    const paths = await prepareRunStorage({
      cwd: "/tmp",
      quarto: "quarto",
      mode: "off",
      nativeArgv: [],
      outputParent: output,
    }, { projectRoot: "/tmp", kind: "standalone" });
    stage = paths.stagingDirectory;
    assert(relative("/tmp", stage).startsWith(".."));
  } finally {
    await Deno.remove(output, { recursive: true });
    if (stage) await Deno.remove(stage, { recursive: true }).catch(() => {});
  }
});
