import { strict as assert } from "node:assert";
import { join } from "node:path";
for (const stage of ["ownership", "live"]) {
  for (const kind of ["esrch", "permission", "io"]) {
    Deno.test(`proc ${stage}: ${kind} preserves only vanished-PID tolerance`, async () => {
      const root = await Deno.makeTempDir();
      try {
        const child = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            new URL("./fixtures/proc-disappeared.ts", import.meta.url).pathname,
            root,
            stage,
            kind,
          ],
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(child.success, new TextDecoder().decode(child.stderr));
        const result = JSON.parse(await Deno.readTextFile(join(root, "result.json")));
        assert(result.injected && result.thrown);
        if (kind === "esrch") {
          assert.equal(result.error, undefined, JSON.stringify(result));
          assert.equal(result.outcome.code, 7);
          assert.equal(result.outcome.signal, null);
          assert.equal(await Deno.readTextFile(join(root, "stdout.log")), "available");
        } else {assert.match(
            result.error,
            kind === "permission" ? /fixture proc permission/ : /Input\/output error/,
          );}
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  }
}
