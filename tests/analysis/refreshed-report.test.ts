import { strict as assert } from "node:assert";
import { join } from "node:path";
import { writeExperimentReport } from "../../src/analysis/report.ts";
import { normalizeRun } from "../../src/analysis/normalize.ts";
import { record } from "../report/fixture.ts";

Deno.test("lazy re-normalization refreshes builds, coverage, summary and both report tables", async () => {
  const root = await Deno.makeTempDir();
  const dir = join(root, "runs/r");
  const load = async (path: string) => JSON.parse(await Deno.readTextFile(join(root, path)));
  try {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.mkdir(join(dir, "events"));
    await Deno.writeTextFile(
      join(dir, "mode.json"),
      JSON.stringify({ runId: "r", experimentId: "e" }),
    );
    await Deno.writeTextFile(join(dir, "events/broken.jsonl"), "{broken\n");
    await Deno.writeTextFile(
      join(dir, "expectations.json"),
      JSON.stringify({ schema_version: 2, processes: [] }),
    );
    await Deno.writeTextFile(
      join(dir, "coverage.json"),
      JSON.stringify({ complete: true, integrity: "valid", observed: { ts: false, lua: false } }),
    );
    const original = { ...record(dir, "r"), dataValid: true };
    await Deno.writeTextFile(join(dir, "run.json"), JSON.stringify(original));
    async function* runs() {
      yield await normalizeRun(dir);
    }
    const result = await writeExperimentReport(
      {
        schema_version: 2,
        projectSource: "org/Fixture",
        replacements: [],
        experimentId: "e",
        sources: [],
        packages: [],
        runtime: {},
      },
      runs(),
      root,
    );
    assert.equal(result.dataValid, false);
    assert.equal((await load("runs/r/run.json")).dataValid, false);
    assert.equal((await load("runs/r/run.json")).outcome.code, 7);
    assert.equal((await load("builds.json"))[0].dataValid, false);
    assert.equal((await load("summary.json")).runs[0].data_valid, false);
    assert.equal((await load("runs/r/summary.json")).dataValid, false);
    assert.equal((await load("coverage.json"))[0].integrity, "invalid");
    assert.equal((await load("coverage.json"))[0].complete, false);
    assert.equal((await load("runs/r/coverage.json")).integrity, "invalid");
    const lines = (await Deno.readTextFile(join(root, "report.md"))).split("\n").filter((line) =>
      line.includes("[VALID]")
    );
    assert.deepEqual(lines, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("completed experiment keeps normalized coverage instead of the preparation snapshot", async () => {
  const { experimentCommand } = await import("../../src/cli/experiment.ts");
  const root = await Deno.makeTempDir();
  try {
    const source = join(root, "source"), workspace = join(root, "workspace");
    await Deno.mkdir(source);
    await Deno.mkdir(workspace);
    await Deno.writeTextFile(join(source, "index.qmd"), "# Fixture\n");
    const git = async (args: string[]) => {
      const out = await new Deno.Command("git", {
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "-C",
          source,
          ...args,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(out.success, new TextDecoder().decode(out.stderr));
      return new TextDecoder().decode(out.stdout).trim();
    };
    await git(["init", "-q"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    const native = await new Deno.Command(Deno.env.get("QUARTO") ?? "quarto", {
      args: ["--paths"],
      stdout: "piped",
    }).output();
    assert(native.success);
    const bin = new TextDecoder().decode(native.stdout).trim().split("\n")[0];
    const share = join(root, "share");
    await Deno.mkdir(join(share, "pandoc/datadir"), { recursive: true });
    await Deno.writeTextFile(join(share, "pandoc/datadir/init.lua"), "-- fixture\n");
    const quarto = join(root, "quarto");
    const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    await Deno.writeTextFile(
      quarto,
      `#!/bin/sh\nif [ "$1" = --paths ]; then printf '%s\\n' ${q(bin)} ${
        q(share)
      }; exit; fi\nif [ "$1" = --version ]; then echo 1.11.6; exit; fi\nif [ "$1" = inspect ]; then printf '{"dir":"%s","files":{"config":[]}}\\n' "$PWD"; exit; fi\nexit 0\n`,
    );
    await Deno.chmod(quarto, 0o755);
    await Deno.writeTextFile(
      join(workspace, "candidate.manifest.json"),
      JSON.stringify({
        schema_version: 2,
        projectSource: "org/Fixture",
        replacements: [],
        experimentId: "e",
        packages: [],
        runtime: {},
        sources: [{
          repository: "org/Fixture",
          sourceKind: "github-baseline",
          remoteRef: "refs/heads/main",
          sha: await git(["rev-parse", "HEAD"]),
          fetchedAt: new Date().toISOString(),
          checkoutPath: source,
        }],
      }),
    );
    const config = join(root, "config.json");
    await Deno.writeTextFile(
      config,
      JSON.stringify({
        schema_version: 2,
        projectSource: "org/Fixture",
        replacements: [],
        sources: [{ repository: "org/Fixture", refPolicy: "remote-default-head" }],
        scenarios: [{
          id: "fixture",
          cwd: ".",
          executable: "quarto",
          args: ["render"],
          cachePolicy: "repeat-render",
          mode: "summary",
          scope: { modules: [], extensions: ["absent"], strict: true },
          resources: { wall: true, cpu: true, peakRss: true },
        }],
      }),
    );
    assert.equal(
      await experimentCommand([
        "run",
        "--workspace",
        workspace,
        "--config",
        config,
        "--scenario",
        "fixture",
        "--quarto",
        quarto,
      ]),
      0,
    );
    const dirs = [...Deno.readDirSync(join(workspace, "runs"))];
    assert.equal(dirs.length, 1);
    const coverage = JSON.parse(
      await Deno.readTextFile(join(workspace, "runs", dirs[0].name, "coverage.json")),
    );
    assert.equal(coverage.integrity, "valid");
    assert.deepEqual(coverage.instrumented, { ts: false, lua: false });
    assert.equal(coverage.packageCoverage.observationStatus, "valid");
    assert.equal(coverage.observations.absent, "unknown");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
