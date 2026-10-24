import { denoCache, quarto as nativeQuarto } from "../runtime.ts";
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
  const cacheParent = await Deno.makeTempDir({ prefix: "perf-cli-cache-" });
  try {
    return await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", cli, "render", ...args],
      cwd: root,
      env: { QUARTO: quarto, DENO_DIR: denoCache, XDG_CACHE_HOME: cacheParent },
      stdout: "piped",
      stderr: "piped",
    }).output();
  } finally {
    await Deno.remove(cacheParent, { recursive: true });
  }
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
    const out = await run(root, nativeQuarto, [
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
    const denied = await run(root, nativeQuarto, ["--perf-output", "reports", "page.qmd"]);
    assert.equal(denied.code, 2);
    assert(decoder.decode(denied.stderr).includes("resources"));
    await assert.rejects(() => Deno.stat(join(root, "reports")), Deno.errors.NotFound);
    await assert.rejects(() => Deno.stat(join(root, "_site")), Deno.errors.NotFound);
    const out = await run(root, nativeQuarto, ["page.qmd"]);
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

Deno.test("mixed TTY rejected sink retains native exit and mandatory report or printed staging", async () => {
  const root = await Deno.makeTempDir();
  const stages: string[] = [];
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  try {
    for (const code of [0, 7]) {
      for (const fail of [false, true]) {
        for (const unlink of [false, true]) {
          const parent = join(root, `output-${code}-${fail}-${unlink}`),
            messages = join(root, `messages-${code}-${fail}-${unlink}`);
          const quarto = await fixture(
            root,
            `${
              fail ? `rm -rf '${parent}'; echo blocker > '${parent}'` : ""
            }\ntrap '' HUP\n(sleep 0.15; echo available-after-native-exit; sleep 0.1) &\nexit ${code}`,
          );
          const source = `import {main} from ${
            JSON.stringify(new URL("../../src/cli.ts", import.meta.url).href)
          };${
            unlink
              ? "const remove=Deno.remove;Deno.remove=async(path,options)=>{if(String(path).endsWith('.pipe'))throw new Error('unlink cleanup blocked');return await remove(path,options);};"
              : ""
          }const sink=new WritableStream({write(chunk){if(new TextDecoder().decode(chunk).includes('available-after-native-exit'))throw new Error('mixed downstream closed')}});Object.defineProperty(Deno.stdout.writable,'getWriter',{value:()=>sink.getWriter()});try{Deno.exit(await main(['render','--perf-output',${
            JSON.stringify(parent)
          }]));}catch(e){console.error(String(e));Deno.exit(2);}`;
          const command = [Deno.execPath(), "eval", source].map(quote).join(" ") + " >" +
            quote(messages);
          const out = await new Deno.Command("script", {
            args: ["-qefc", command, "/dev/null"],
            cwd: root,
            env: { QUARTO: quarto, SHELL: "/bin/sh" },
            stdin: "null",
            stdout: "piped",
            stderr: "piped",
          }).output();
          const message = decoder.decode(out.stdout);
          assert.equal(out.code, code === 7 ? 7 : 4, message);
          assert(message.includes("mixed downstream closed"), message);
          let dir: string;
          if (fail || unlink) {
            const stage = message.match(/staging сохранён: ([^: \n]+)/)?.[1];
            assert(stage, message);
            stages.push(stage);
            dir = stage;
          } else dir = await onlyRun(parent);
          const r = JSON.parse(await Deno.readTextFile(join(dir, "run.json")));
          assert.equal(r.outcome.code, code);
          assert.equal(r.dataValid, false);
          assert(r.quality.errors.some((s: string) => s.includes("mixed downstream closed")));
          assert(
            (await Deno.readTextFile(join(dir, "stdout.log"))).includes(
              "available-after-native-exit",
            ),
          );
          await Deno.stat(join(dir, "report.md"));
          assert.equal(
            (await Array.fromAsync(Deno.readDir(dir))).some((e) => e.name.endsWith(".pipe")),
            unlink,
          );
          assert(
            JSON.parse(await Deno.readTextFile(join(dir, "performance-error.json"))).error.includes(
              "mixed downstream closed",
            ),
          );
        }
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
    for (const s of stages) await Deno.remove(s, { recursive: true });
  }
});
Deno.test("sink failure and failed finalization preserve original external signals with staged report", async () => {
  const root = await Deno.makeTempDir();
  const stages: string[] = [];
  try {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const parent = join(root, signal), failed = join(root, signal + "-failed");
      const quarto = await fixture(
        root,
        `rm -rf '${parent}'; echo blocker > '${parent}'\ntrap '' INT TERM\necho native-ready\nwhile :; do sleep 1; done`,
      );
      const source = `import {main} from ${
        JSON.stringify(new URL("../../src/cli.ts", import.meta.url).href)
      };const sink=new WritableStream({write(chunk){if(new TextDecoder().decode(chunk).includes('native-ready')){Deno.writeTextFileSync(${
        JSON.stringify(failed)
      },'failed');throw new Error('signal downstream closed')}}});Object.defineProperty(Deno.stdout.writable,'getWriter',{value:()=>sink.getWriter()});try{Deno.exit(await main(['render','--perf-output',${
        JSON.stringify(parent)
      }]));}catch(e){console.error(String(e));Deno.exit(2);}`;
      const child = new Deno.Command(Deno.execPath(), {
        args: ["eval", source],
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
            await Deno.stat(failed);
            break;
          } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) throw e;
          }
          assert(Date.now() < deadline);
          await new Promise((r) => setTimeout(r, 10));
        }
        child.kill(signal);
        const out = await output;
        const message = decoder.decode(out.stderr);
        assert.equal(out.signal, signal, message);
        const stage = message.match(/staging сохранён: ([^: \n]+)/)?.[1];
        assert(stage, message);
        stages.push(stage);
        const r = JSON.parse(await Deno.readTextFile(join(stage, "run.json")));
        assert.equal(r.outcome.signal, "SIGKILL");
        assert(r.quality.errors.some((s: string) => s.includes("signal downstream closed")));
        await Deno.stat(join(stage, "report.md"));
      } finally {
        try {
          child.kill("SIGTERM");
        } catch { /* Already stopped. */ }
        await output;
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
    for (const s of stages) await Deno.remove(s, { recursive: true });
  }
});
Deno.test("unwritable diagnostic stderr preserves native payload and known exit with saved report", async () => {
  const root = await Deno.makeTempDir();
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  try {
    for (const code of [0, 7]) {
      const parent = join(root, `out-${code}`);
      const quarto = await fixture(root, `echo native-payload\nexit ${code}`);
      const command =
        [Deno.execPath(), "run", "-A", cli, "render", "--perf-output", parent].map(quote).join(
          " ",
        ) + " 2>/dev/full";
      const out = await new Deno.Command("/bin/sh", {
        args: ["-c", command],
        cwd: root,
        env: { QUARTO: quarto },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(out.code, code === 7 ? 7 : 4);
      assert.equal(decoder.decode(out.stdout), "native-payload\n");
      assert.equal(decoder.decode(out.stderr), "");
      const dir = await onlyRun(parent);
      await Deno.stat(join(dir, "report.md"));
      assert.equal(JSON.parse(await Deno.readTextFile(join(dir, "run.json"))).outcome.code, code);
      await Deno.stat(join(dir, "performance-error.json"));
    }
    const blocked = join(root, "blocked-parent");
    await Deno.writeTextFile(blocked, "existing");
    const quarto = await fixture(root, "echo unexpected-native; exit 7");
    const command =
      [Deno.execPath(), "run", "-A", cli, "render", "--perf-output", blocked].map(quote).join(" ") +
      " 2>/dev/full";
    const out = await new Deno.Command("/bin/sh", {
      args: ["-c", command],
      cwd: root,
      env: { QUARTO: quarto },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(out.code, 2);
    assert.equal(decoder.decode(out.stdout), "");
    assert.equal(decoder.decode(out.stderr), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("diagnostic receipt does not follow an existing symlink after failed finalization", async () => {
  const root = await Deno.makeTempDir();
  let stage = "";
  try {
    const keep = join(root, "keep");
    await Deno.writeTextFile(keep, "original");
    const quarto = await fixture(root, "exit 7");
    const source = `import {main} from ${
      JSON.stringify(new URL("../../src/cli.ts", import.meta.url).href)
    };const write=Deno.writeTextFile;Deno.writeTextFile=async(path,data,options)=>{if(String(path).endsWith('/run.json')){const record=JSON.parse(data);await Deno.symlink(${
      JSON.stringify(keep)
    },record.collectionDirectory+'/performance-error.json');}return await write(path,data,options);};Deno.exit(await main(['render']));`;
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["eval", source],
      cwd: root,
      env: { QUARTO: quarto },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const message = decoder.decode(out.stderr);
    stage = message.match(/staging сохранён: ([^: \n]+)/)?.[1] ?? "";
    assert.equal(out.code, 7, message);
    assert(stage, message);
    await Deno.stat(join(stage, "report.md"));
    assert.equal(await Deno.readTextFile(keep), "original");
  } finally {
    await Deno.remove(root, { recursive: true });
    if (stage) await Deno.remove(stage, { recursive: true }).catch(() => {});
  }
});

Deno.test("CLI keeps native zero and seven and reports complete final after partial staging cleanup", async () => {
  const root = await Deno.makeTempDir();
  const stages: string[] = [];
  try {
    for (const code of [0, 7]) {
      const parent = join(root, `output-${code}`), stageReceipt = join(root, `stage-${code}`);
      const quarto = await fixture(root, `echo native-payload\nexit ${code}`);
      const source = `import {main} from ${
        JSON.stringify(new URL("../../src/cli.ts", import.meta.url).href)
      };const write=Deno.writeTextFile;Deno.writeTextFile=async(path,data,options)=>{if(String(path).endsWith('/run.json')){const record=JSON.parse(data),stage=record.collectionDirectory;await write(${
        JSON.stringify(stageReceipt)
      },stage);await Deno.mkdir(stage+'/protected');await write(stage+'/protected/raw.jsonl','raw');await Deno.chmod(stage+'/protected',0o500);}return await write(path,data,options);};Deno.exit(await main(['render','--perf-output',${
        JSON.stringify(parent)
      }]));`;
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["eval", source],
        cwd: root,
        env: { QUARTO: quarto },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stage = await Deno.readTextFile(stageReceipt);
      stages.push(stage);
      const message = decoder.decode(out.stderr);
      assert.equal(out.code, code, message);
      assert.equal(decoder.decode(out.stdout), "native-payload\n");
      const final = message.match(/Отчёт Performance: ([^\r\n]+)/)?.[1];
      assert(final, message);
      assert.equal(final, await onlyRun(parent));
      for (
        const file of ["run.json", "summary.json", "report.md", "stdout.log", "protected/raw.jsonl"]
      ) await Deno.stat(join(final, file));
      assert(message.includes("не удалось полностью очистить остаток staging"), message);
      assert(message.includes(stage), message);
      assert.equal(JSON.parse(await Deno.readTextFile(join(final, "run.json"))).outcome.code, code);
    }
  } finally {
    for (const stage of stages) {
      await Deno.chmod(join(stage, "protected"), 0o700).catch(() => {});
      await Deno.remove(stage, { recursive: true }).catch(() => {});
    }
    await Deno.remove(root, { recursive: true });
  }
});
