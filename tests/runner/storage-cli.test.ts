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
    assert.equal(r.completion.native?.code, 7);
    assert.equal(r.request.mode, "off");
    assert.equal(r.schema_version, 2);
    await Deno.stat(join(dir, "report.md"));
    await assert.rejects(() => Deno.stat(join(root, ".quarto/foreign")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("CLI publication failure prints the last confirmed staging report", async () => {
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
      assert.equal(out.code, 2, decoder.decode(out.stderr));
      const message = decoder.decode(out.stderr);
      const stage = message.match(/last confirmed: ([^\r\n]+)/)?.[1];
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
Deno.test("CLI saves incomplete staging evidence then re-raises the original external signal", async () => {
  const root = await Deno.makeTempDir();
  const stages: string[] = [];
  try {
    const testStat = await Deno.readTextFile("/proc/self/stat");
    const testGroup = Number(testStat.slice(testStat.lastIndexOf(")") + 2).split(" ")[2]);
    assert(Number.isSafeInteger(testGroup) && testGroup > 0);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const fail of [false, true]) {
        const parent = join(root, `${signal}-${fail}`),
          ready = join(root, `ready-${signal}-${fail}`);
        const quarto = await fixture(
          root,
          `${
            fail ? `rm -rf '${parent}'; echo blocker > '${parent}'` : ""
          }\ntrap '' INT TERM\necho evidence-before-signal\ncat /proc/$$/stat > '${ready}.tmp'\nmv '${ready}.tmp' '${ready}'\nwhile :; do sleep 1; done`,
        );
        const child = new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", cli, "render", "--perf-output", parent],
          cwd: root,
          env: { QUARTO: quarto },
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const output = child.output();
        let ownedGroup: number | undefined;
        try {
          const deadline = Date.now() + 10000;
          while (true) {
            try {
              const nativeStat = await Deno.readTextFile(ready);
              const nativePid = Number(nativeStat.slice(0, nativeStat.indexOf(" ")));
              const fields = nativeStat.slice(nativeStat.lastIndexOf(")") + 2).split(" ");
              const group = Number(fields[2]), session = Number(fields[3]);
              assert(Number.isSafeInteger(nativePid) && nativePid > 1);
              assert(Number.isSafeInteger(group) && group > 1);
              assert.notEqual(nativePid, Deno.pid);
              assert.notEqual(nativePid, child.pid);
              assert.notEqual(group, testGroup);
              assert.equal(group, session);
              ownedGroup = group;
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
          const dir = decoder.decode(out.stderr)
            .match(/Отчёт Performance: ([^;\r\n]+); completion=incomplete; data=INVALID/)?.[1];
          assert(dir, decoder.decode(out.stderr));
          stages.push(dir);
          assert.equal(
            await Deno.readTextFile(join(dir, "stdout.log")),
            "evidence-before-signal\n",
          );
          const r = JSON.parse(await Deno.readTextFile(join(dir, "run.json")));
          assert.equal(r.completion.kind, "incomplete");
          assert.equal(r.completion.requestedSignal, signal);
          assert.equal(r.completion.native, null);
          assert.equal(r.dataValid, false);
          if (fail) assert((await Deno.stat(parent)).isFile);
          else assert.deepEqual(await Array.fromAsync(Deno.readDir(parent)), []);
          await Deno.stat(join(dir, "report.md"));
        } finally {
          try {
            if (ownedGroup !== undefined) {
              try {
                Deno.kill(-ownedGroup, "SIGKILL");
              } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) throw error;
              }
            }
          } finally {
            try {
              child.kill("SIGKILL");
            } catch { /* Already stopped. */ }
            await output;
          }
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
      const dir = decoder.decode(out.stderr).match(/Отчёт Performance: ([^;\r\n]+)/)?.[1];
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

Deno.test("mixed TTY rejected sink retains an incomplete staged report and available payload", async () => {
  const root = await Deno.makeTempDir();
  const stages: string[] = [];
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  try {
    for (const code of [0, 7]) {
      for (const fail of [false, true]) {
        const parent = join(root, `output-${code}-${fail}`),
          messages = join(root, `messages-${code}-${fail}`);
        const quarto = await fixture(
          root,
          `${
            fail ? `rm -rf '${parent}'; echo blocker > '${parent}'` : ""
          }\ntrap '' HUP\n(sleep 0.15; echo available-after-native-exit; sleep 0.1) &\nexit ${code}`,
        );
        const source = `import {main} from ${
          JSON.stringify(new URL("../../src/cli.ts", import.meta.url).href)
        };const sink=new WritableStream({write(chunk){if(new TextDecoder().decode(chunk).includes('available-after-native-exit'))throw new Error('mixed downstream closed')}});Object.defineProperty(Deno.stdout.writable,'getWriter',{value:()=>sink.getWriter()});try{Deno.exit(await main(['render','--perf-output',${
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
        assert.equal(out.code, 4, message);
        const dir = message
          .match(/Отчёт Performance: ([^;\r\n]+); completion=incomplete; data=INVALID/)?.[1];
        assert(dir, message);
        stages.push(dir);
        const r = JSON.parse(await Deno.readTextFile(join(dir, "run.json")));
        assert.equal(r.completion.kind, "incomplete");
        assert.equal(r.completion.reason, "observation-error");
        assert.equal(r.completion.native, null);
        assert.equal(r.dataValid, false);
        assert(r.quality.errors.some((s: string) => s.includes("mixed downstream closed")));
        assert(
          (await Deno.readTextFile(join(dir, "stdout.log"))).includes(
            "available-after-native-exit",
          ),
        );
        await Deno.stat(join(dir, "report.md"));
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
      assert.equal(out.code, code);
      assert.equal(decoder.decode(out.stdout), "native-payload\n");
      assert.equal(decoder.decode(out.stderr), "");
      const dir = await onlyRun(parent);
      await Deno.stat(join(dir, "report.md"));
      assert.equal(JSON.parse(await Deno.readTextFile(join(dir, "run.json"))).completion.native?.code, code);
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
Deno.test("CLI keeps native zero and seven and reports complete final after partial staging cleanup", async () => {
  const root = await Deno.makeTempDir();
  const stages: string[] = [];
  try {
    for (const code of [0, 7]) {
      const parent = join(root, `output-${code}`), stageReceipt = join(root, `stage-${code}`);
      const quarto = await fixture(root, `echo native-payload\nexit ${code}`);
      const source = `import {main} from ${
        JSON.stringify(new URL("../../src/cli.ts", import.meta.url).href)
      };const write=Deno.writeTextFile;Deno.writeTextFile=async(path,data,options)=>{if(/\\/run\\.[^/]+\\.tmp$/.test(String(path))){const record=JSON.parse(data),stage=record.collectionDirectory;if(record.completion.reason!=='not-finalized')return await write(path,data,options);await write(${
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
      const final = message.match(/Отчёт Performance: ([^;\r\n]+)/)?.[1];
      assert(final, message);
      assert.equal(final, await onlyRun(parent));
      for (
        const file of ["run.json", "summary.json", "report.md", "stdout.log", "protected/raw.jsonl"]
      ) await Deno.stat(join(final, file));
      assert(message.includes("не удалось полностью очистить остаток staging"), message);
      assert(message.includes(stage), message);
      assert.equal(JSON.parse(await Deno.readTextFile(join(final, "run.json"))).completion.native?.code, code);
    }
  } finally {
    for (const stage of stages) {
      await Deno.chmod(join(stage, "protected"), 0o700).catch(() => {});
      await Deno.remove(stage, { recursive: true }).catch(() => {});
    }
    await Deno.remove(root, { recursive: true });
  }
});
