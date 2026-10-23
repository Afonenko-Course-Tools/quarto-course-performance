import { strict as assert } from "node:assert";
import { join } from "node:path";
const cli = new URL("../../src/cli.ts", import.meta.url).pathname;
const decoder = new TextDecoder();
async function fixture(root: string, body: string) {
  const executable = join(root, "quarto-fixture");
  await Deno.writeTextFile(
    executable,
    `#!/bin/sh\nif [ "$1" = inspect ]; then printf '%s\\n' '{"dir":"${root}","files":{"config":[]}}'; exit; fi\nif [ "$1" = --version ]; then echo 1.11.6; exit; fi\n${body}\n`,
  );
  await Deno.chmod(executable, 0o755);
  return executable;
}
async function run(root: string, quarto: string, args: string[] = []) {
  return await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", cli, "render", ...args],
    cwd: root,
    env: { QUARTO: quarto, XDG_CACHE_HOME: join(root, "cache") },
    stdout: "piped",
    stderr: "piped",
  }).output();
}
async function onlyRun(root: string) {
  const dirs = [];
  for await (const e of Deno.readDir(root)) if (e.isDirectory) dirs.push(e.name);
  assert.equal(dirs.length, 1);
  return join(root, dirs[0]);
}
Deno.test("off CLI preserves two separators, force-clean logs and report without adding no-clean", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, ".quarto/foreign"), { recursive: true });
    const quarto = await fixture(
      root,
      `rm -rf .quarto\nprintf '%s\\n' "$@"\necho stderr-evidence >&2\nexit 7`,
    );
    const out = await run(root, quarto, ["--", "--output-dir", "_site", "--", "--help"]);
    assert.equal(out.code, 7, decoder.decode(out.stderr));
    const dir = await onlyRun(join(root, ".quarto/course-perf/runs"));
    assert.equal(
      await Deno.readTextFile(join(dir, "stdout.log")),
      "render\n--output-dir\n_site\n--\n--help\n",
    );
    assert.equal(await Deno.readTextFile(join(dir, "stderr.log")), "stderr-evidence\n");
    const r = JSON.parse(await Deno.readTextFile(join(dir, "run.json")));
    assert.equal(r.outcome.code, 7);
    assert.equal(r.request.mode, "off");
    assert.equal(r.schema_version, 2);
    await Deno.stat(join(dir, "report.md"));
    await assert.rejects(() => Deno.stat(join(root, ".quarto/foreign")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("CLI finalize failure prints existing staging and preserves native failure priority", async () => {
  const root = await Deno.makeTempDir();
  const stages: string[] = [];
  try {
    for (const code of [0, 7]) {
      const parent = join(root, `out-${code}`);
      const quarto = await fixture(
        root,
        `rm -rf '${parent}'\necho blocker > '${parent}'\necho available\nexit ${code}`,
      );
      const out = await run(root, quarto, ["--perf-output", parent]);
      assert.equal(out.code, code === 0 ? 4 : 7, decoder.decode(out.stderr));
      const message = decoder.decode(out.stderr);
      const stage = message.match(/staging сохранён: ([^: \n]+)/)?.[1];
      assert(stage, message);
      stages.push(stage);
      assert.equal(await Deno.readTextFile(join(stage, "stdout.log")), "available\n");
      await Deno.stat(join(stage, "report.md"));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
    for (const s of stages) await Deno.remove(s, { recursive: true });
  }
});
Deno.test("off CLI real standalone render creates mandatory report and relative output from cwd", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(root, "page.qmd"), "# Test\n");
    const out = await run(root, "/usr/bin/quarto", [
      "--perf-output",
      "reports",
      "page.qmd",
      "--output-dir",
      "site",
    ]);
    assert.equal(out.code, 0, decoder.decode(out.stderr));
    const dir = await onlyRun(join(root, "reports"));
    await Deno.stat(join(dir, "report.md"));
    await Deno.stat(join(root, "site/page.html"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("git provenance precedes output creation and allows dirty and non-git workspaces", async () => {
  const root = await Deno.makeTempDir();
  const git = async (args: string[]) => {
    const out = await new Deno.Command("git", { args, cwd: root, stdout: "piped", stderr: "piped" })
      .output();
    assert.equal(out.code, 0);
  };
  try {
    const quarto = await fixture(root, "exit 0");
    await git(["init", "-q"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.org",
      "commit",
      "-qm",
      "initial",
    ]);
    for (const dirty of [false, true]) {
      if (dirty) await Deno.writeTextFile(join(root, "source"), "dirty");
      const out = await run(root, quarto, [
        "--perf-output",
        join(root, dirty ? "second" : "first"),
      ]);
      assert.equal(out.code, 0, decoder.decode(out.stderr));
      const dir = await onlyRun(join(root, dirty ? "second" : "first"));
      assert.equal(JSON.parse(await Deno.readTextFile(join(dir, "run.json"))).git.dirty, dirty);
    }
    await assert.rejects(() => Deno.stat(join(root, ".gitignore")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("resources star excludes default scratch and rejects custom output before render", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(root, "_quarto.yml"),
      'project:\n  type: website\n  resources: ["**"]\nformat:\n  html:\n    theme: none\n',
    );
    await Deno.writeTextFile(join(root, "page.qmd"), "# Test\n");
    const denied = await run(root, "/usr/bin/quarto", ["--perf-output", "reports", "page.qmd"]);
    assert.equal(denied.code, 2);
    assert(decoder.decode(denied.stderr).includes("resources"));
    await assert.rejects(() => Deno.stat(join(root, "reports")), Deno.errors.NotFound);
    await assert.rejects(() => Deno.stat(join(root, "_site")), Deno.errors.NotFound);
    const out = await run(root, "/usr/bin/quarto", ["page.qmd"]);
    assert.equal(out.code, 0, decoder.decode(out.stderr));
    await onlyRun(join(root, ".quarto/course-perf/runs"));
    await assert.rejects(() => Deno.stat(join(root, "_site/.quarto")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("CLI saves available evidence then re-raises original external signals despite escalation and report failure", async () => {
  const root = await Deno.makeTempDir();
  const stages: string[] = [];
  try {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const fail of [false, true]) {
        const parent = join(root, `${signal}-${fail}`),
          ready = join(root, `ready-${signal}-${fail}`);
        const quarto = await fixture(
          root,
          `${
            fail ? `rm -rf '${parent}'; echo blocker > '${parent}'` : ""
          }\ntrap '' INT TERM\necho evidence-before-signal\necho ready > '${ready}'\nwhile :; do sleep 1; done`,
        );
        const child = new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", cli, "render", "--perf-output", parent],
          cwd: root,
          env: { QUARTO: quarto },
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const output = child.output();
        try {
          const deadline = Date.now() + 10000;
          while (true) {
            try {
              await Deno.stat(ready);
              break;
            } catch (e) {
              if (!(e instanceof Deno.errors.NotFound)) throw e;
            }
            assert(Date.now() < deadline, "child readiness timeout");
            await new Promise((r) => setTimeout(r, 10));
          }
          child.kill(signal);
          const out = await output;
          assert.equal(out.signal, signal, decoder.decode(out.stderr));
          let dir: string;
          if (fail) {
            const stage = decoder.decode(out.stderr).match(/staging сохранён: ([^: \n]+)/)?.[1];
            assert(stage, decoder.decode(out.stderr));
            stages.push(stage);
            dir = stage;
          } else dir = await onlyRun(parent);
          assert.equal(
            await Deno.readTextFile(join(dir, "stdout.log")),
            "evidence-before-signal\n",
          );
          const r = JSON.parse(await Deno.readTextFile(join(dir, "run.json")));
          assert.equal(r.outcome.signal, "SIGKILL");
          assert.equal(r.outcome.escalated, true);
          await Deno.stat(join(dir, "report.md"));
        } finally {
          try {
            child.kill("SIGKILL");
          } catch { /* Already stopped. */ }
          await output;
        }
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
    for (const s of stages) await Deno.remove(s, { recursive: true });
  }
});
Deno.test("prior default run history does not make unchanged sources dirty", async () => {
  const root = await Deno.makeTempDir();
  const git = async (args: string[]) => {
    const out = await new Deno.Command("git", { args, cwd: root, stdout: "piped", stderr: "piped" })
      .output();
    assert.equal(out.code, 0);
  };
  try {
    const quarto = await fixture(root, "exit 0");
    await git(["init", "-q"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.org",
      "commit",
      "-qm",
      "initial",
    ]);
    for (let i = 0; i < 2; i++) {
      const out = await run(root, quarto);
      assert.equal(out.code, 0, decoder.decode(out.stderr));
    }
    for await (const e of Deno.readDir(join(root, ".quarto/course-perf/runs"))) {
      const r = JSON.parse(
        await Deno.readTextFile(join(root, ".quarto/course-perf/runs", e.name, "run.json")),
      );
      assert.equal(r.git.dirty, false);
    }
    await assert.rejects(() => Deno.stat(join(root, ".gitignore")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("custom output history is excluded without hiding source files beside it", async () => {
  const root = await Deno.makeTempDir();
  const git = async (args: string[]) => {
    const out = await new Deno.Command("git", { args, cwd: root, stdout: "piped", stderr: "piped" })
      .output();
    assert.equal(out.code, 0);
  };
  try {
    const quarto = await fixture(root, "exit 0");
    await git(["init", "-q"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.org",
      "commit",
      "-qm",
      "initial",
    ]);
    for (let i = 0; i < 3; i++) {
      if (i === 2) await Deno.writeTextFile(join(root, "reports/source.qmd"), "changed source");
      const out = await run(root, quarto, ["--perf-output", "reports"]);
      assert.equal(out.code, 0, decoder.decode(out.stderr));
      const dir = decoder.decode(out.stderr).match(/Отчёт Performance: (.+)/)?.[1];
      assert(dir);
      const r = JSON.parse(await Deno.readTextFile(join(dir, "run.json")));
      assert.equal(r.git.dirty, i === 2);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("foreign target provenance describes rendered sources rather than invocation directory", async () => {
  const root = await Deno.makeTempDir();
  const git = async (args: string[]) => {
    const out = await new Deno.Command("git", { args, cwd: root, stdout: "piped", stderr: "piped" })
      .output();
    assert.equal(out.code, 0);
  };
  const caller = await Deno.makeTempDir();
  try {
    const quarto = await fixture(root, "exit 0");
    await git(["init", "-q"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.org",
      "commit",
      "-qm",
      "initial",
    ]);
    const out = await run(caller, quarto, [root]);
    assert.equal(out.code, 0, decoder.decode(out.stderr));
    const dir = await onlyRun(join(root, ".quarto/course-perf/runs"));
    const r = JSON.parse(await Deno.readTextFile(join(dir, "run.json")));
    assert.equal(r.git?.root, root);
    assert.equal(r.git.dirty, false);
    assert.equal(r.request.cwd, caller);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(caller, { recursive: true });
  }
});
