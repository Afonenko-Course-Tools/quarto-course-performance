import { strict as assert } from "node:assert";
import { join } from "node:path";
import { object, parseObject } from "../../src/json.ts";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.test(`scenario CLI waits for native completion then preserves external ${signal}`, async () => {
    const root = await Deno.makeTempDir({ prefix: "scenario external signal " });
    let child: Deno.ChildProcess | undefined;
    try {
      const ready = join(root, "ready"), entry = join(root, "native.ts");
      await Deno.writeTextFile(
        entry,
        `await Deno.writeTextFile(${
          JSON.stringify(ready)
        },String(Deno.pid));setInterval(()=>{},1000);await new Promise(()=>{});`,
      );
      const executor = new URL("../../src/runner/execute.ts", import.meta.url).href;
      const program = `import {executeScenario,withScenarioSignals} from ${
        JSON.stringify(executor)
      };await withScenarioSignals(async(abortSignal)=>{await executeScenario({id:'signal',cwd:'.',executable:Deno.execPath(),args:['run','-A',${
        JSON.stringify(entry)
      }],cachePolicy:'repeat-render',mode:'off',scope:{modules:[],extensions:[],strict:true},resources:{wall:true,cpu:true,peakRss:true}},{root:${
        JSON.stringify(root)
      },variant:'candidate',manifest:{schema_version:2,projectSource:'org/Fixture',experimentId:'e',sources:[],packages:[],runtime:{}}},'off',{abortSignal,outputRoot:${
        JSON.stringify(join(root, "runs"))
      }})});`;
      child = new Deno.Command(Deno.execPath(), {
        args: ["eval", program],
        stdout: "null",
        stderr: "null",
      }).spawn();
      const deadline = performance.now() + 5000;
      while (true) {
        try {
          await Deno.stat(ready);
          break;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          if (performance.now() > deadline) throw new Error("Native did not start");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      child.kill(signal);
      const status = await child.status;
      assert.equal(status.signal, signal);
      const runs = [];
      for await (const entry of Deno.readDir(join(root, "runs"))) runs.push(entry.name);
      assert.equal(runs.length, 1);
      const record = parseObject(await Deno.readTextFile(join(root, "runs", runs[0]!, "run.json")));
      assert.equal(object(record.outcome).signal, signal);
      assert.notEqual(object(record.outcome).code, 0);
    } finally {
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch { /* Already reaped. */ }
        await child.status;
      }
      await Deno.remove(root, { recursive: true });
    }
  });
}
