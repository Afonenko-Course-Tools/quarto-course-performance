import { strict as assert } from "node:assert";
import { join } from "node:path";
for (const kind of ["permission", "io", "enumeration"]) {
  for (const stage of ["live", "complete"]) {
    Deno.test(`supervisor drains owned tree before returning persistent ${kind} error (${stage})`, async () => {
      const root = await Deno.makeTempDir();
      try {
        const output = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            new URL("./fixtures/proc-supervisor-failure.ts", import.meta.url).pathname,
            root,
            kind,
            stage,
          ],
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(output.success, new TextDecoder().decode(output.stderr));
        const result = JSON.parse(await Deno.readTextFile(join(root, "result.json")));
        assert(result.injected, JSON.stringify(result));
        assert.match(
          result.error,
          kind === "permission"
            ? /persistent proc permission/
            : kind === "enumeration"
            ? /persistent proc enumeration/
            : /persistent Input\/output/,
        );
        assert.equal(result.before, result.after, JSON.stringify(result));
        assert.equal(result.controlled, true);
        assert.equal(await Deno.readTextFile(join(root, "stdout.log")), "available");
        assert.equal(result.siblingAlive, true);
        if (stage === "complete") assert.equal(result.nativeCode, 7);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  }
}
