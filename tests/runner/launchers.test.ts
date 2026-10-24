import { dataDir, pandoc } from "../runtime.ts";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { prepareLaunchers } from "../../src/launchers/setup.ts";
Deno.test("Deno launcher uses real binary, preserves main and args, and flushes on Deno.exit", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf launch " });
  try {
    const setup = await prepareLaunchers({
      workspace: root,
      deno: Deno.execPath(),
      pandoc: pandoc,
      dataDir: dataDir,
    });
    const path = join(root, "entry.ts");
    await Deno.writeTextFile(
      path,
      "if(import.meta.main)console.log(JSON.stringify(Deno.args));Deno.exit(23);",
    );
    const out = await new Deno.Command(setup.env.QUARTO_DENO, {
      args: ["run", "-A", path, "arg space"],
      env: {
        ...setup.env,
        COURSE_PERF_MODE: "summary",
        COURSE_PERF_EXPERIMENT_ID: "e",
        COURSE_PERF_RUN_ID: "r",
        COURSE_PERF_OUTPUT_DIR: root,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(out.code, 23, new TextDecoder().decode(out.stderr));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(out.stdout)), ["arg space"]);
    const dirs = [];
    for await (const dir of Deno.readDir(join(root, "events"))) dirs.push(dir.name);
    assert.equal(dirs.length, 1);
    const summary = JSON.parse(
      await Deno.readTextFile(join(root, "events", dirs[0], "ts.summary.json")),
    );
    assert.equal(summary.run_id, "r");
    assert(summary.data_valid);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("Lua data-dir bootstrap preserves original initialization and installs one agent in the shared state of two filter files", async () => {
  const root = await Deno.makeTempDir();
  try {
    const data = join(root, "original-data");
    await Deno.mkdir(data);
    await Deno.writeTextFile(join(data, "init.lua"), "ORIGINAL_INIT_VALUE=7\n");
    const setup = await prepareLaunchers({
      workspace: root,
      deno: Deno.execPath(),
      pandoc: pandoc,
      dataDir: data,
    });
    for (const name of ["a", "b"]) {
      await Deno.writeTextFile(
        join(root, name + ".lua"),
        "assert(ORIGINAL_INIT_VALUE==7);assert(__course_performance_agent_v1);return {}\n",
      );
    }
    const out = await new Deno.Command(setup.env.QUARTO_PANDOC, {
      args: [
        "--lua-filter",
        join(root, "a.lua"),
        "--lua-filter",
        join(root, "b.lua"),
        "-t",
        "plain",
      ],
      env: {
        ...setup.env,
        COURSE_PERF_MODE: "summary",
        COURSE_PERF_EXPERIMENT_ID: "e",
        COURSE_PERF_RUN_ID: "r",
        COURSE_PERF_OUTPUT_DIR: root,
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    let summaries = 0;
    for await (const dir of Deno.readDir(join(root, "events"))) {
      for await (const file of Deno.readDir(join(root, "events", dir.name))) {
        if (file.name.endsWith(".summary.json")) summaries++;
      }
    }
    assert.equal(summaries, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CPU profiles have independent process outputs and preserve program success", async () => {
  const root = await Deno.makeTempDir();
  try {
    const setup = await prepareLaunchers({
      workspace: root,
      deno: Deno.execPath(),
      pandoc: pandoc,
      dataDir: dataDir,
    });
    const entry = join(root, "cpu.ts");
    await Deno.writeTextFile(entry, "for(let i=0;i<1000000;i++)Math.sqrt(i);console.log('done');");
    for (let n = 0; n < 2; n++) {
      const out = await new Deno.Command(setup.env.QUARTO_DENO, {
        args: ["run", "-A", entry],
        env: {
          ...setup.env,
          COURSE_PERF_MODE: "cpu",
          COURSE_PERF_EXPERIMENT_ID: "e",
          COURSE_PERF_RUN_ID: "r",
          COURSE_PERF_OUTPUT_DIR: root,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(out.success, new TextDecoder().decode(out.stderr));
    }
    const dirs = [];
    for await (const dir of Deno.readDir(join(root, "profiles"))) dirs.push(dir.name);
    assert.equal(dirs.length, 2);
    for (const id of dirs) {
      const p = JSON.parse(await Deno.readTextFile(join(root, "profiles", id, "cpu.cpuprofile")));
      assert(p.nodes.length > 0);
      assert(p.endTime >= p.startTime);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("SIGTERM flushes incomplete TS work and preserves the signal; SIGKILL stays partial", async () => {
  const root = await Deno.makeTempDir();
  try {
    const setup = await prepareLaunchers({
      workspace: root,
      deno: Deno.execPath(),
      pandoc: pandoc,
      dataDir: dataDir,
    });
    const entry = join(root, "signal.ts");
    await Deno.writeTextFile(
      entry,
      `import {createMetrics} from ${
        JSON.stringify(new URL("../../bridge/bridge.ts", import.meta.url).href)
      };await Deno.writeTextFile(Deno.args[0],String(Deno.pid));await createMetrics('test').wrapAsync({id:'pending',kind:'phase'},async()=>await new Promise(r=>setTimeout(r,30000)))();`,
    );
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const output = join(root, signal), ready = join(root, signal + ".ready");
      await Deno.mkdir(output);
      const child = new Deno.Command(setup.env.QUARTO_DENO, {
        args: ["run", "-A", entry, ready],
        env: {
          ...setup.env,
          COURSE_PERF_MODE: "summary",
          COURSE_PERF_EXPERIMENT_ID: "e",
          COURSE_PERF_RUN_ID: "r",
          COURSE_PERF_OUTPUT_DIR: output,
        },
        stdout: "null",
        stderr: "null",
      }).spawn();
      let found = false;
      for (let i = 0; i < 200; i++) {
        try {
          await Deno.stat(ready);
          found = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      if (!found) {
        child.kill();
        await child.status;
        throw new Error("Программа не запустилась");
      }
      await new Promise((r) => setTimeout(r, 20));
      if (signal === "SIGKILL") Deno.kill(Number(await Deno.readTextFile(ready)), signal);
      else child.kill(signal);
      const status = await child.status;
      assert.equal(status.signal, signal);
      if (signal === "SIGTERM") {
        let summary;
        for await (const process of Deno.readDir(join(output, "events"))) {
          summary = JSON.parse(
            await Deno.readTextFile(join(output, "events", process.name, "ts.summary.json")),
          );
        }
        assert(summary.incomplete_spans > 0);
        assert.equal(summary.data_valid, false);
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("owned group forwards each signal once through a launcher", async () => {
  const { runOwnedProcess } = await import("../../src/runner/process.ts");
  const root = await Deno.makeTempDir();
  try {
    const setup = await prepareLaunchers({
      workspace: root,
      deno: Deno.execPath(),
      pandoc,
      dataDir,
    });
    const entry = join(root, "once.ts"), ready = join(root, "ready"), count = join(root, "count");
    await Deno.writeTextFile(
      entry,
      `Deno.addSignalListener('SIGTERM',()=>{Deno.writeTextFileSync(${
        JSON.stringify(count)
      },'x',{append:true});setTimeout(()=>Deno.exit(7),80)});Deno.writeTextFileSync(${
        JSON.stringify(ready)
      },'yes');setInterval(()=>{},100);`,
    );
    const abort = new AbortController();
    const running = runOwnedProcess({
      executable: setup.env.QUARTO_DENO,
      args: ["run", "-A", entry],
      cwd: root,
      env: { ...Deno.env.toObject(), ...setup.env, COURSE_PERF_MODE: "off" },
      stdoutPath: join(root, "out"),
      stderrPath: join(root, "err"),
      abortSignal: abort.signal,
    });
    for (let n = 0; n < 300; n++) {
      try {
        await Deno.stat(ready);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    await Deno.stat(ready);
    abort.abort("SIGTERM");
    const result = await running;
    assert.equal(await Deno.readTextFile(count), "x");
    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
    assert.equal(result.escalated, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Pandoc launcher preserves custom data-dir in both forms and initializes it once", async () => {
  const root = await Deno.makeTempDir();
  try {
    const custom = join(root, "custom data");
    await Deno.mkdir(custom);
    const original = "CUSTOM_INIT=true;INIT_COUNT=(INIT_COUNT or 0)+1\n";
    await Deno.writeTextFile(join(custom, "init.lua"), original);
    const filter = join(root, "custom.lua");
    await Deno.writeTextFile(filter, "assert(CUSTOM_INIT);assert(INIT_COUNT==1);return {}\n");
    const setup = await prepareLaunchers({
      workspace: join(root, "launchers"),
      deno: Deno.execPath(),
      pandoc,
      dataDir,
    });
    for (const mode of ["off", "summary", "cpu"]) {
      for (const form of [["--data-dir", custom], ["--data-dir=" + custom]]) {
        const output = join(root, mode + "-" + form.length);
        const out = await new Deno.Command(setup.env.QUARTO_PANDOC, {
          args: [...form, "--lua-filter", filter, "-t", "plain"],
          env: {
            ...setup.env,
            COURSE_PERF_MODE: mode,
            COURSE_PERF_RUN_ID: "r",
            COURSE_PERF_EXPERIMENT_ID: "e",
            COURSE_PERF_OUTPUT_DIR: output,
          },
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(out.success, `${mode} ${form}: ${new TextDecoder().decode(out.stderr)}`);
        assert.equal(await Deno.readTextFile(join(custom, "init.lua")), original);
        assert.deepEqual([...Deno.readDirSync(custom)].map((e) => e.name), ["init.lua"]);
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Pandoc bootstrap preserves non-UTF8 Lua string bytes in the user init", async () => {
  const root = await Deno.makeTempDir();
  try {
    const data = join(root, "data");
    await Deno.mkdir(data);
    const prefix = new TextEncoder().encode("INIT_BYTE='");
    const suffix = new TextEncoder().encode("'\n");
    const source = new Uint8Array([...prefix, 255, ...suffix]);
    await Deno.writeFile(join(data, "init.lua"), source);
    const filter = join(root, "filter.lua");
    await Deno.writeTextFile(filter, "assert(string.byte(INIT_BYTE)==255);return {}\n");
    const setup = await prepareLaunchers({
      workspace: join(root, "launchers"),
      deno: Deno.execPath(),
      pandoc,
      dataDir: data,
    });
    for (const mode of ["off", "summary"]) {
      const out = await new Deno.Command(setup.env.QUARTO_PANDOC, {
        args: ["--data-dir", data, "--lua-filter", filter, "-t", "plain"],
        env: {
          ...setup.env,
          COURSE_PERF_MODE: mode,
          COURSE_PERF_RUN_ID: "r",
          COURSE_PERF_EXPERIMENT_ID: "e",
          COURSE_PERF_OUTPUT_DIR: join(root, "output"),
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(out.success, `${mode}: ${new TextDecoder().decode(out.stderr)}`);
    }
    assert.deepEqual(await Deno.readFile(join(data, "init.lua")), source);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Pandoc init loader preserves terminal return sibling files and exactly one original initialization", async () => {
  const { treeHash } = await import("../../src/sources/snapshot.ts");
  const root = await Deno.makeTempDir();
  try {
    const data = join(root, "original-data");
    await Deno.mkdir(data);
    await Deno.writeTextFile(join(data, "sibling.lua"), "return 17\n");
    await Deno.writeTextFile(
      join(data, "init.lua"),
      "CUSTOM_INIT=true;INIT_COUNT=(INIT_COUNT or 0)+1;assert(dofile(PANDOC_STATE.user_data_dir..'/sibling.lua')==17);return 'preserved',nil,17\n",
    );
    const before = await treeHash(data);
    const setup = await prepareLaunchers({
      workspace: join(root, "launchers"),
      deno: Deno.execPath(),
      pandoc,
      dataDir: data,
    });
    const filter = join(root, "filter.lua");
    await Deno.writeTextFile(filter, "assert(CUSTOM_INIT);assert(INIT_COUNT==1);return {}\n");
    for (const mode of ["off", "summary", "cpu"]) {
      const out = await new Deno.Command(setup.env.QUARTO_PANDOC, {
        args: ["--data-dir", data, "--lua-filter", filter, "--lua-filter", filter, "-t", "plain"],
        env: {
          ...setup.env,
          COURSE_PERF_MODE: mode,
          COURSE_PERF_RUN_ID: "r",
          COURSE_PERF_EXPERIMENT_ID: "e",
          COURSE_PERF_OUTPUT_DIR: join(root, mode),
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(out.success, `${mode}: ${new TextDecoder().decode(out.stderr)}`);
    }
    // Отдельный явный loadfile проверяет возвращаемый tuple публичного init-loader.
    await Deno.writeTextFile(
      filter,
      "INIT_COUNT=0;local r=table.pack(dofile(os.getenv('COURSE_PERF_DATA_DIR')..'/init.lua'));assert(r.n==3 and r[1]=='preserved' and r[2]==nil and r[3]==17);assert(INIT_COUNT==1);return {}\n",
    );
    const returned = await new Deno.Command(pandoc, {
      args: ["--data-dir", setup.env.COURSE_PERF_DATA_DIR, "--lua-filter", filter, "-t", "plain"],
      env: { ...setup.env, COURSE_PERF_MODE: "off" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(returned.success, new TextDecoder().decode(returned.stderr));
    assert.equal(await treeHash(data), before);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Pandoc data-dir materializes selected external file and directory links without changing originals", async () => {
  const { treeHash, hashBytes } = await import("../../src/sources/snapshot.ts");
  const root = await Deno.makeTempDir();
  try {
    const data = join(root, "data"), external = join(root, "external");
    await Deno.mkdir(data);
    await Deno.mkdir(join(external, "siblings"), { recursive: true });
    await Deno.writeTextFile(
      join(external, "init.lua"),
      "CUSTOM_INIT=true;INIT_COUNT=(INIT_COUNT or 0)+1;assert(dofile(PANDOC_STATE.user_data_dir..'/siblings/module.lua')==17);return 'native'\n",
    );
    await Deno.writeTextFile(join(external, "siblings/module.lua"), "return 17\n");
    await Deno.symlink(join(external, "init.lua"), join(data, "init.lua"));
    await Deno.symlink(join(external, "siblings"), join(data, "siblings"));
    const originalHash = async () =>
      await hashBytes(
        new TextEncoder().encode(
          JSON.stringify([
            await Deno.readLink(join(data, "init.lua")),
            await Deno.readLink(join(data, "siblings")),
            await treeHash(external),
          ]),
        ),
      );
    const before = await originalHash();
    const filter = join(root, "filter.lua"), input = join(root, "input.md");
    await Deno.writeTextFile(filter, "assert(CUSTOM_INIT);assert(INIT_COUNT==1);return {}\n");
    await Deno.writeTextFile(input, "Native linked data.\n");
    const native = await new Deno.Command(pandoc, {
      args: [
        "--data-dir",
        data,
        "--lua-filter",
        filter,
        "--lua-filter",
        filter,
        "-t",
        "plain",
        input,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(native.success, new TextDecoder().decode(native.stderr));
    assert.equal(new TextDecoder().decode(native.stdout), "Native linked data.\n");
    const setup = await prepareLaunchers({
      workspace: join(root, "launchers"),
      deno: Deno.execPath(),
      pandoc,
      dataDir: data,
    });
    for (const mode of ["off", "summary", "cpu"]) {
      for (const form of [["--data-dir", data], ["--data-dir=" + data]]) {
        const out = await new Deno.Command(setup.env.QUARTO_PANDOC, {
          args: [...form, "--lua-filter", filter, "--lua-filter", filter, "-t", "plain", input],
          env: {
            ...setup.env,
            COURSE_PERF_MODE: mode,
            COURSE_PERF_RUN_ID: "r",
            COURSE_PERF_EXPERIMENT_ID: "e",
            COURSE_PERF_OUTPUT_DIR: join(root, "output"),
          },
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(out.success, `${mode}: ${new TextDecoder().decode(out.stderr)}`);
        assert.deepEqual(out.stdout, native.stdout);
      }
    }
    assert.equal(await originalHash(), before);
    assert((await Deno.lstat(join(data, "init.lua"))).isSymlink);
    assert((await Deno.lstat(join(data, "siblings"))).isSymlink);
    assert(!(await Deno.lstat(join(setup.env.COURSE_PERF_DATA_DIR, "siblings"))).isSymlink);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Pandoc data-dir preparation rejects directory cycles and special files explicitly", async () => {
  const { preparePandocData } = await import("../../src/launchers/setup.ts");
  const root = await Deno.makeTempDir();
  try {
    const data = join(root, "data");
    await Deno.mkdir(data);
    await Deno.symlink(data, join(data, "loop"));
    await assert.rejects(() => preparePandocData(data, join(root, "cycle"), "unused.lua"), /Цикл/);
    await Deno.remove(join(data, "loop"));
    await assert.rejects(
      () => preparePandocData(data, join(data, "nested"), "unused.lua"),
      /внутри источника/,
    );
    await assert.rejects(() => Deno.stat(join(data, "nested")), Deno.errors.NotFound);
    const fifo = await new Deno.Command("mkfifo", { args: [join(data, "pipe")] }).output();
    assert(fifo.success);
    await assert.rejects(
      () => preparePandocData(data, join(root, "special"), "unused.lua"),
      /Специальный файл/,
    );
    await Deno.remove(join(data, "pipe"));
    await Deno.symlink(join(root, "missing"), join(data, "unavailable"));
    await assert.rejects(
      () => preparePandocData(data, join(root, "unavailable"), "unused.lua"),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
