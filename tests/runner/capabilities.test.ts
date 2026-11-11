import { strict as assert } from "node:assert";
import { join } from "node:path";
import { probeDenoCpu } from "../../src/adapters/quarto/capabilities.ts";

Deno.test("CPU capability executes the effective runtime even when help hides profiler flags", async () => {
  const result = await probeDenoCpu(Deno.execPath(), Deno.env.toObject());
  assert.deepEqual(result, { status: "available" });
});

Deno.test("CPU capability distinguishes unsupported flags, failed artifacts and bounded runtime errors", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf-cpu-contract-" });
  try {
    const executable = join(root, "deno");
    const captured = join(root, "directory");
    await Deno.writeTextFile(
      executable,
      `#!/usr/bin/env -S ${Deno.execPath()} run -A
const directory = Deno.args[Deno.args.indexOf('--cpu-prof-dir') + 1];
Deno.writeTextFileSync(${JSON.stringify(captured)}, directory);
switch (Deno.env.get('PROBE_CASE')) {
  case 'unsupported': console.error("unexpected argument '--cpu-prof-dir' found"); Deno.exit(2);
  case 'failure': console.error('runtime initialization failed'); Deno.exit(7);
  case 'invalid': Deno.writeTextFileSync(directory + '/probe.cpuprofile', '{}'); break;
  case 'missing': break;
  case 'timeout': setInterval(() => {}, 100); break;
}
`,
    );
    await Deno.chmod(executable, 0o755);
    for (const kind of ["unsupported", "failure", "invalid", "missing", "timeout"]) {
      const result = await probeDenoCpu(executable, {
        ...Deno.env.toObject(),
        PROBE_CASE: kind,
      }, kind === "timeout" ? 200 : 2000);
      assert.equal(result.status, kind === "unsupported" ? "unsupported" : "error");
      assert(result.reason.length > 0);
      if (kind === "timeout") {
        assert(result.status === "error");
        assert.match(result.reason, /время ожидания/);
      }
      const directory = await Deno.readTextFile(captured);
      await assert.rejects(() => Deno.stat(directory), Deno.errors.NotFound);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
