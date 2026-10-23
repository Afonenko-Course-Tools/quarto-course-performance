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
