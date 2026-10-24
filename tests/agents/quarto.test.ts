import { dataDir, pandoc } from "../runtime.ts";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { prepareFilterAdapter } from "../../src/adapters/quarto/filter-trace.ts";
Deno.test("filter adapter excludes skipped nil/empty filters and does not pretend each run is a walk", async () => {
  const root = await Deno.makeTempDir(), source = join(root, "source"), copy = join(root, "copy");
  try {
    await Deno.mkdir(join(source, "filters"), { recursive: true });
    await Deno.writeTextFile(
      join(source, "filters/main.lua"),
      "function run_emulated_filter(doc, filter, traverser) return doc end\n_quarto={}\n_quarto.ast = {}\n",
    );
    const receipt = await prepareFilterAdapter(source, copy);
    assert.notEqual(receipt.sourceHash, receipt.preparedHash);
    const script = join(root, "test.lua"),
      agent = new URL("../../src/agents/lua/agent.lua", import.meta.url).pathname;
    await Deno.writeTextFile(
      script,
      `local a=dofile(${
        JSON.stringify(agent)
      }){experimentId='e',runId='r',processId='p',executorId='lua',outputDirectory=${
        JSON.stringify(root)
      },mode='summary'}
  dofile(${JSON.stringify(join(copy, "filters/main.lua"))})
  run_emulated_filter(nil,{Str=function(s)return s end});run_emulated_filter(pandoc.Pandoc{},{});run_emulated_filter(pandoc.Pandoc{}, {Str=function(s)return s end});a.flush();return {}`,
    );
    const result = await new Deno.Command(pandoc, {
      args: ["--lua-filter", script, "-t", "plain"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    const s = JSON.parse(await Deno.readTextFile(join(root, "events/p/lua.summary.json")));
    assert.equal(s.counters.filter_runs, 1);
    assert(!Object.keys(s.counters).some((k) => k.startsWith("walk_api_calls")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("simple summary works without private Quarto filter adapter and cpu writes a V8 profile", async () => {
  const { renderCommand } = await import("../../src/runner/render.ts");
  const root = await Deno.makeTempDir();
  try {
    const bridge = new URL("../../bridge/bridge.lua", import.meta.url).pathname;
    await Deno.writeTextFile(
      join(root, "doc.qmd"),
      "---\nformat: gfm\nfilters: [owner.lua]\n---\n\nNative preserved paragraph.\n",
    );
    await Deno.writeTextFile(
      join(root, "owner.lua"),
      `local m=dofile(${
        JSON.stringify(bridge)
      }).create_metrics('fixture');return {{Pandoc=m.wrap_sync({id='fixture.owner',kind='phase'},function(doc)local f=assert(io.open('init-observation.txt','w'));f:write(tostring(CUSTOM_INIT),'/',tostring(INIT_COUNT));f:close();return doc end)}}`,
    );
    await Deno.mkdir(join(root, "custom"));
    await Deno.writeTextFile(
      join(root, "custom/init.lua"),
      "CUSTOM_INIT=true;INIT_COUNT=(INIT_COUNT or 0)+1\n",
    );
    // Quarto 1.11.6 сам выбирает share data-dir, сохраняя argv в своём UI.
    for (const mode of ["off", "summary", "cpu"] as const) {
      for (
        const form of [["--data-dir", join(root, "custom")], ["--data-dir=" + join(root, "custom")]]
      ) {
        const outputParent = join(root, "results", mode + form.length);
        assert.equal(
          await renderCommand({
            cwd: root,
            quarto: "/usr/bin/quarto",
            nativeArgv: ["doc.qmd", ...form],
            mode,
            outputParent,
          }),
          0,
        );
        assert.equal(
          await Deno.readTextFile(join(root, "doc.md")),
          "\n\nNative preserved paragraph.\n",
        );
        assert.equal(await Deno.readTextFile(join(root, "init-observation.txt")), "nil/nil");
        assert.equal(
          await Deno.readTextFile(join(root, "custom/init.lua")),
          "CUSTOM_INIT=true;INIT_COUNT=(INIT_COUNT or 0)+1\n",
        );
        if (mode === "off") continue;
        const [entry] = [...Deno.readDirSync(outputParent)];
        const output = join(outputParent, entry.name);
        const coverage = JSON.parse(await Deno.readTextFile(join(output, "coverage.json")));
        assert.equal(coverage.complete, false);
        assert.equal(coverage.operations["quarto.filter.run"].available, false);
        const run = JSON.parse(await Deno.readTextFile(join(output, "run.json")));
        assert.deepEqual(run.request.nativeArgv, ["doc.qmd", ...form]);
        assert(run.preparation.length > 0);
        assert(!run.preparation.some((r: { kind: string }) => r.kind === "quarto-adapter"));
        await assert.rejects(
          () => Deno.stat(join(output, "diagnostic/share/filters/main.lua")),
          Deno.errors.NotFound,
        );
        const summary = JSON.parse(await Deno.readTextFile(join(output, "summary.json")));
        assert(
          summary.operations.some((o: { operationId: string; completed: number }) =>
            o.operationId === "fixture.owner" && o.completed === 1
          ),
        );
        if (mode === "cpu") {
          const profiles = [...Deno.readDirSync(join(output, "profiles"))];
          assert(profiles.length > 0);
          const profile = JSON.parse(
            await Deno.readTextFile(join(output, "profiles", profiles[0].name, "cpu.cpuprofile")),
          );
          assert(profile.nodes.length > 0);
          assert(profile.endTime > profile.startTime);
        }
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("public render preparation preserves selected binaries share and functional options", async () => {
  const { prepareRenderDiagnostic } = await import("../../src/runner/diagnostic.ts");
  const root = await Deno.makeTempDir();
  const keys = [
    "QUARTO_DENO",
    "QUARTO_PANDOC",
    "QUARTO_SHARE_PATH",
    "QUARTO_DENO_EXTRA_OPTIONS",
    "QUARTO_DENO_V8_OPTIONS",
  ];
  const original = keys.map((key) => Deno.env.get(key));
  try {
    const selectedShare = join(root, "selected-share");
    await Deno.mkdir(join(selectedShare, "pandoc/datadir"), { recursive: true });
    await Deno.writeTextFile(join(selectedShare, "version"), "1.11.6\n");
    await Deno.writeTextFile(join(selectedShare, "pandoc/datadir/init.lua"), "CUSTOM_INIT=true\n");
    // Обёртки реально исполняют выбранные binaries; private main.lua отсутствует.
    const selectedDeno = join(root, "selected-deno"),
      selectedPandoc = join(root, "selected-pandoc");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const [path, binary] of [[selectedDeno, Deno.execPath()], [selectedPandoc, pandoc]]) {
      await Deno.writeTextFile(path, `#!/bin/sh\nexec ${quote(binary)} "$@"\n`);
      await Deno.chmod(path, 0o755);
    }
    const values = [
      selectedDeno,
      selectedPandoc,
      selectedShare,
      "--location=https://fixture.invalid/",
      "--stack-size=2048",
    ];
    keys.forEach((key, i) => Deno.env.set(key, values[i]));
    const request = {
      cwd: root,
      quarto: "/usr/bin/quarto",
      nativeArgv: [],
      mode: "summary" as const,
    };
    const prepared = await prepareRenderDiagnostic(request, {
      projectRoot: root,
      kind: "standalone",
    }, join(root, "workspace"));
    assert.equal(prepared.coverage.runtime.deno, selectedDeno);
    assert.equal(prepared.coverage.runtime.pandoc, selectedPandoc);
    assert.equal(prepared.coverage.runtime.share, selectedShare);
    assert.equal(prepared.coverage.runtime.filterAdapter, false);
    assert.equal(prepared.env.COURSE_PERF_REAL_DENO, selectedDeno);
    assert.equal(prepared.env.COURSE_PERF_REAL_PANDOC, selectedPandoc);
    assert.deepEqual(keys.map((key) => Deno.env.get(key)), values);
    assert.equal(
      await Deno.readTextFile(join(selectedShare, "pandoc/datadir/init.lua")),
      "CUSTOM_INIT=true\n",
    );
    const filter = join(root, "observed.lua");
    const bridge = new URL("../../bridge/bridge.lua", import.meta.url).pathname;
    await Deno.writeTextFile(
      filter,
      `assert(CUSTOM_INIT);local m=dofile(${
        JSON.stringify(bridge)
      }).create_metrics('fixture');return {{Pandoc=m.wrap_sync({id='fixture.public',kind='phase'},function(doc)return doc end)}}`,
    );
    const observed = join(root, "observed");
    const out = await new Deno.Command(prepared.env.QUARTO_PANDOC, {
      args: ["--lua-filter", filter, "-t", "plain"],
      env: {
        ...prepared.env,
        COURSE_PERF_MODE: "summary",
        COURSE_PERF_EXPERIMENT_ID: "e",
        COURSE_PERF_RUN_ID: "r",
        COURSE_PERF_OUTPUT_DIR: observed,
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    const { normalizeRun } = await import("../../src/analysis/normalize.ts");
    const normalized = await normalizeRun(observed);
    assert(
      normalized.events.some((event) =>
        event.operation_id === "fixture.public" && event.event === "end"
      ),
    );
    Deno.env.set("QUARTO_DENO_EXTRA_OPTIONS", "--cpu-prof");
    await assert.rejects(
      () =>
        prepareRenderDiagnostic(
          request,
          { projectRoot: root, kind: "standalone" },
          join(root, "conflict"),
        ),
      /Конфликт.*QUARTO_DENO_EXTRA_OPTIONS/,
    );
    Deno.env.delete("QUARTO_DENO_EXTRA_OPTIONS");
    await Deno.writeTextFile(selectedDeno, "#!/bin/sh\nprintf 'unsupported selected runtime\\n'\n");
    await assert.rejects(
      () =>
        prepareRenderDiagnostic(
          request,
          { projectRoot: root, kind: "standalone" },
          join(root, "unsupported"),
        ),
      /Выбранный runtime не поддерживает/,
    );
    await assert.rejects(() => Deno.stat(join(root, "unsupported")), Deno.errors.NotFound);
  } finally {
    keys.forEach((key, i) =>
      original[i] === undefined ? Deno.env.delete(key) : Deno.env.set(key, original[i]!)
    );
    await Deno.remove(root, { recursive: true });
  }
});
