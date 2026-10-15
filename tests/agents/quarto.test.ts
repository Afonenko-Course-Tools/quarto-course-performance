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
