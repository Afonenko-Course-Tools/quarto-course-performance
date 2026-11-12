import { strict as assert } from "node:assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freezeVariants, validateFreezeInputs } from "../../src/sources/freeze.ts";
import { git } from "../../src/sources/git.ts";
import { prepareVariant } from "../../src/sources/prepare.ts";
import { quarto as nativeQuarto } from "../runtime.ts";

Deno.test("freeze pins generic trusted local candidates without Hyperfine and preserves previous manifests", async () => {
  const root = await Deno.makeTempDir();
  const oldPath = Deno.env.get("PATH")!;
  try {
    const baseline = join(root, "baseline"), candidate = join(root, "candidate");
    await Deno.mkdir(baseline);
    for (
      const args of [["init", "-q"], ["config", "user.name", "Fixture"], [
        "config",
        "user.email",
        "fixture@example.invalid",
      ]]
    ) await git(["-C", baseline, ...args]);
    await Deno.writeTextFile(join(baseline, "index.qmd"), "# Other course");
    await git(["-C", baseline, "add", "."]);
    await git(["-C", baseline, "commit", "-qm", "base"]);
    const baseSha = await git(["-C", baseline, "rev-parse", "HEAD"]);
    await git(["clone", "-q", baseline, candidate]);
    await git(["-C", candidate, "config", "user.name", "Fixture"]);
    await git(["-C", candidate, "config", "user.email", "fixture@example.invalid"]);
    await Deno.writeTextFile(join(candidate, "index.qmd"), "# Candidate");
    await git(["-C", candidate, "commit", "-qam", "candidate"]);
    const candidateSha = await git(["-C", candidate, "rev-parse", "HEAD"]);
    const bin = join(root, "bin");
    await Deno.mkdir(bin);
    for (const name of ["hyperfine", "unzip"]) {
      await Deno.writeTextFile(
        join(bin, name),
        `#!/bin/sh\necho forbidden >> '${root}/forbidden'\nexit 91\n`,
      );
      await Deno.chmod(join(bin, name), 0o755);
    }
    Deno.env.set("PATH", bin + ":" + oldPath);
    const inputs = {
      projectSource: "org/Other",
      variants: {
        upstream: baseline,
        "clean-control": baseline,
        candidate: candidate,
      },
    };
    const workspace = join(root, "experiment");
    const frozen = await freezeVariants(inputs, workspace, nativeQuarto);
    assert(frozen.candidate?.sources[0]);
    assert.equal(frozen.candidate?.sources[0]?.sha, candidateSha);

    assert.equal(frozen.upstream?.sources[0]?.sha, baseSha);

    assert.equal(frozen.candidate?.sources[0].sourceKind, "local-candidate");
    assert.equal(frozen.candidate?.schema_version, 2);
    assert.equal(frozen.candidate?.runtime.hyperfine, undefined);
    await assert.rejects(() => Deno.stat(join(root, "forbidden")), Deno.errors.NotFound);
    const before = await Deno.readTextFile(join(workspace, "candidate.manifest.json"));
    await assert.rejects(() => freezeVariants(inputs, workspace, nativeQuarto), /закреплён/);
    assert.equal(await Deno.readTextFile(join(workspace, "candidate.manifest.json")), before);
    assert(frozen.candidate && frozen.upstream);
    const copies = join(root, "copies");
    await Deno.mkdir(copies);
    const a = await prepareVariant(frozen.upstream, "upstream", copies);
    const b = await prepareVariant(frozen.candidate, "candidate", copies);
    assert.equal(await Deno.readTextFile(join(a.root, "index.qmd")), "# Other course");
    assert.equal(await Deno.readTextFile(join(b.root, "index.qmd")), "# Candidate");
    const candidateManifest = frozen.candidate;
    await assert.rejects(
      () =>
        prepareVariant(
          {
            ...candidateManifest,
            sources: candidateManifest.sources.map((source) => ({
              ...source,
              sha: "a".repeat(40),
            })),
          },
          "candidate",
          copies,
        ),
      /SHA/,
    );
    await Deno.writeTextFile(join(candidate, ".git/info/exclude"), "ignored-extension.lua\n");
    await Deno.writeTextFile(
      join(candidate, "ignored-extension.lua"),
      "uncommitted ignored source",
    );
    const ignoredWorkspace = join(root, "ignored");
    await Deno.mkdir(ignoredWorkspace);
    const exported = await prepareVariant(candidateManifest, "candidate", ignoredWorkspace);
    await assert.rejects(
      () => Deno.stat(join(exported.root, "ignored-extension.lua")),
      Deno.errors.NotFound,
    );
    await Deno.writeTextFile(join(candidate, "index.qmd"), "dirty");
    await assert.rejects(() => prepareVariant(frozen.candidate!, "candidate", copies), /dirty/);
    await assert.rejects(() => freezeVariants(inputs, join(root, "dirty"), nativeQuarto), /dirty/);
    assert.throws(() => validateFreezeInputs({ ...inputs, variants: { candidate } }));
    assert.throws(
      () => validateFreezeInputs({ ...inputs, baseline: "/obsolete.json" }),
      /baseline/,
    );
  } finally {
    Deno.env.set("PATH", oldPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("native Quarto installs and renders the selected prepared variant packages", async () => {
  const root = await Deno.makeTempDir();
  async function command(executable: string, args: string[], cwd = root) {
    const result = await new Deno.Command(executable, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
  }
  try {
    const variants: Record<string, string> = {};
    for (const marker of ["upstream", "candidate"]) {
      const owner = join(root, marker + "-owner"), course = join(root, marker);
      const extension = join(owner, "_extensions/variant-marker");
      await Deno.mkdir(extension, { recursive: true });
      await Deno.mkdir(course);
      await Deno.writeTextFile(
        join(extension, "_extension.yml"),
        "title: Variant marker\nauthor: Fixture\nversion: 1.0.0\ncontributes:\n  filters: [filter.lua]\n",
      );
      await Deno.writeTextFile(
        join(extension, "filter.lua"),
        `function Para(p) p.content:insert(pandoc.Str("${marker}")); return p end\n`,
      );
      await Deno.writeTextFile(
        join(course, "_quarto.yml"),
        "project:\n  type: default\n  output-dir: _site\nformat: html\nfilters: [variant-marker]\n",
      );
      await Deno.writeTextFile(join(course, "index.qmd"), "# Fixture\n\nSelected: ");
      await command(nativeQuarto, ["add", owner, "--no-prompt"], course);
      await git(["-C", course, "init", "-q"]);
      // Native tooling gitlinks are valid course metadata; their contents are not render inputs.
      await git(["-C", owner, "init", "-q"]);
      await git(["-C", owner, "add", "."]);
      await git([
        "-C",
        owner,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        marker,
      ]);
      await git([
        "-C",
        course,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        owner,
        ".ci/tooling",
      ]);

      await git(["-C", course, "add", "."]);
      await git([
        "-C",
        course,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        marker,
      ]);
      variants[marker] = course;
    }
    const configPath = join(root, "config.json"),
      inputsPath = join(root, "inputs.json"),
      workspace = join(root, "experiment");
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        schema_version: 2,
        projectSource: "fixture/course",
        scenarios: [{
          id: "page",
          cwd: ".",
          executable: "quarto",
          args: ["render", "index.qmd"],
          cachePolicy: "repeat-render",
          mode: "off",
          scope: { modules: [], extensions: [], strict: true },
          resources: { wall: true, cpu: true, peakRss: true },
        }],
      }),
    );
    await Deno.writeTextFile(
      inputsPath,
      JSON.stringify({
        projectSource: "fixture/course",
        variants: {
          upstream: variants.upstream,
          "clean-control": variants.upstream,
          candidate: variants.candidate,
        },
      }),
    );
    const cliPath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
    const common = ["run", "-A", cliPath, "experiment"];
    await command(Deno.execPath(), [
      ...common,
      "freeze",
      "--config",
      configPath,
      "--workspace",
      workspace,
      "--inputs",
      inputsPath,
      "--quarto",
      nativeQuarto,
    ]);
    for (const variant of ["upstream", "candidate"]) {
      await command(Deno.execPath(), [
        ...common,
        "run",
        "--config",
        configPath,
        "--workspace",
        workspace,
        "--scenario",
        "page",
        "--variant",
        variant,
        "--quarto",
        nativeQuarto,
      ]);
      let html: string | undefined;
      for await (const entry of Deno.readDir(workspace)) {
        if (!entry.name.startsWith("prepared-")) continue;
        try {
          html = await Deno.readTextFile(join(workspace, entry.name, variant, "_site/index.html"));
          await assert.rejects(
            () =>
              Deno.stat(
                join(
                  workspace,
                  entry.name,
                  variant,
                  ".ci/tooling/_extensions/variant-marker/_extension.yml",
                ),
              ),
            Deno.errors.NotFound,
          );
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
      assert(
        html && new RegExp(String.raw`Selected:\s*${variant}`).test(html),
        `Selected ${variant} filter did not execute: ${html?.match(/Selected:[^<]*/)?.[0]}`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
