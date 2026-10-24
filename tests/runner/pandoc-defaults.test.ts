import { strict as assert } from "node:assert";
import { join } from "node:path";
import { prepareLaunchers } from "../../src/launchers/setup.ts";
import { files, treeHash } from "../../src/sources/snapshot.ts";
import { dataDir, pandoc } from "../runtime.ts";
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
Deno.test("standalone Pandoc preserves native default init, resources and missing default in every mode", async () => {
  const root = await Deno.makeTempDir();
  try {
    const setup = await prepareLaunchers({
      workspace: join(root, "launchers"),
      deno: Deno.execPath(),
      pandoc,
      dataDir,
    });
    const input = join(root, "input.html");
    await Deno.writeTextFile(input, "<p>native text</p>");
    const filter = join(root, "filter.lua");
    for (const custom of [false, true]) {
      const xdg = join(root, custom ? "custom" : "missing"), source = join(xdg, "pandoc");
      if (custom) {
        await Deno.mkdir(source, { recursive: true });
        await Deno.writeTextFile(join(source, "sibling.lua"), "return 17\n");
        const prefix = new TextEncoder().encode(
          "INIT_COUNT=(INIT_COUNT or 0)+1;NEIGHBOUR=dofile(PANDOC_STATE.user_data_dir..'/sibling.lua');INIT_BYTE='",
        );
        await Deno.writeFile(
          join(source, "init.lua"),
          new Uint8Array([
            ...prefix,
            255,
            ...new TextEncoder().encode("';return 'original',nil,17\n"),
          ]),
        );
      }
      await Deno.writeTextFile(
        filter,
        custom
          ? "assert(INIT_COUNT==1);assert(NEIGHBOUR==17);assert(string.byte(INIT_BYTE)==255);return {}\n"
          : "assert(INIT_COUNT==nil);return {}\n",
      );
      const before = custom ? await treeHash(source) : null;
      const args = ["--from=html", "--to=json", "--lua-filter", filter, input];
      const base: Record<string, string> = {
        ...Deno.env.toObject(),
        XDG_DATA_HOME: xdg,
        QUARTO_SHARE_PATH: join(dataDir, "../.."),
      };
      delete base.QUARTO_FILTER_PARAMS;
      const native = await new Deno.Command(pandoc, {
        args,
        env: base,
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(native.success, decode(native.stderr));
      for (const mode of ["off", "summary", "cpu", "trace"]) {
        const output = join(root, String(custom), mode);
        const out = await new Deno.Command(setup.env.QUARTO_PANDOC, {
          args,
          env: {
            ...base,
            ...setup.env,
            COURSE_PERF_MODE: mode,
            COURSE_PERF_RUN_ID: "r",
            COURSE_PERF_EXPERIMENT_ID: "e",
            COURSE_PERF_OUTPUT_DIR: output,
          },
          clearEnv: true,
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert.equal(out.code, native.code, `${custom}/${mode}: ${decode(out.stderr)}`);
        assert.deepEqual(out.stdout, native.stdout);
        assert.equal(decode(out.stderr), decode(native.stderr));
        if (mode !== "off") {
          assert((await files(join(output, "events"))).some((p) => p.endsWith(".summary.json")));
        }
      }
      if (custom) assert.equal(await treeHash(source), before);
      else await assert.rejects(() => Deno.stat(source), Deno.errors.NotFound);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("ordered Pandoc defaults remain native off and diagnostics refuse unresolved final defaults before conversion", async () => {
  const root = await Deno.makeTempDir();
  try {
    const setup = await prepareLaunchers({
      workspace: join(root, "launchers"),
      deno: Deno.execPath(),
      pandoc,
      dataDir,
    });
    const explicit = join(root, "explicit"), fromDefaults = join(root, "defaults data");
    for (const [path, value] of [[explicit, "explicit"], [fromDefaults, "defaults"]]) {
      await Deno.mkdir(path);
      await Deno.writeTextFile(
        join(path, "init.lua"),
        `SELECTED='${value}';INIT_COUNT=(INIT_COUNT or 0)+1\n`,
      );
    }
    const defaults = join(root, "defaults.yaml");
    await Deno.writeTextFile(defaults, `data-dir: ${JSON.stringify(fromDefaults)}\n`);
    const marker = join(root, "converted"), filter = join(root, "filter.lua");
    await Deno.writeTextFile(
      filter,
      `assert(INIT_COUNT==1);local f=assert(io.open(${
        JSON.stringify(marker)
      },'w'));f:write(SELECTED);f:close();return {}\n`,
    );
    const tail = ["--from=html", "--to=json", "--lua-filter", filter];
    for (
      const form of [["--defaults", defaults], ["--defaults=" + defaults], ["-d", defaults], [
        "-d" + defaults,
      ]]
    ) {
      const unresolved = ["--data-dir", explicit, ...form, ...tail];
      const off = await new Deno.Command(setup.env.QUARTO_PANDOC, {
        args: unresolved,
        env: { ...setup.env, COURSE_PERF_MODE: "off" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(off.success, decode(off.stderr));
      assert.equal(await Deno.readTextFile(marker), "defaults");
      await Deno.remove(marker);
      const out = await new Deno.Command(setup.env.QUARTO_PANDOC, {
        args: unresolved,
        env: {
          ...setup.env,
          COURSE_PERF_MODE: "summary",
          COURSE_PERF_RUN_ID: "r",
          COURSE_PERF_EXPERIMENT_ID: "e",
          COURSE_PERF_OUTPUT_DIR: join(root, "unsupported"),
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.notEqual(out.code, 0);
      assert.match(decode(out.stderr), /defaults.*data-dir|data-dir.*defaults/i);
      await assert.rejects(() => Deno.stat(marker), Deno.errors.NotFound);
      const supported = await new Deno.Command(setup.env.QUARTO_PANDOC, {
        args: [...form, "--data-dir=" + explicit, ...tail],
        env: {
          ...setup.env,
          COURSE_PERF_MODE: "summary",
          COURSE_PERF_RUN_ID: "r",
          COURSE_PERF_EXPERIMENT_ID: "e",
          COURSE_PERF_OUTPUT_DIR: join(root, "supported"),
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(supported.success, decode(supported.stderr));
      assert.equal(await Deno.readTextFile(marker), "explicit");
      await Deno.remove(marker);
    }
    await Deno.writeTextFile(join(root, "--defaults=literal"), "<p>literal filename</p>");
    const separated = await new Deno.Command(setup.env.QUARTO_PANDOC, {
      args: ["--data-dir", explicit, ...tail, "--", "--defaults=literal"],
      cwd: root,
      env: {
        ...setup.env,
        COURSE_PERF_MODE: "summary",
        COURSE_PERF_RUN_ID: "r",
        COURSE_PERF_EXPERIMENT_ID: "e",
        COURSE_PERF_OUTPUT_DIR: join(root, "separator"),
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(separated.success, decode(separated.stderr));
    assert.equal(await Deno.readTextFile(marker), "explicit");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
