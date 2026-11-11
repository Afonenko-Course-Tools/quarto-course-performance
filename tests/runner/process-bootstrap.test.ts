import { strict as assert } from "node:assert";
import { join } from "node:path";
import { OwnedProcessError, runOwnedProcess } from "../../src/runner/process.ts";
import { runNativeRender } from "../../src/runner/render.ts";

Deno.test("bootstrap exit cannot invent native success or failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf-bootstrap-" });
  try {
    for (
      const bootstrap of ["exit 0", "exit 9", "kill -TERM $$", "kill -INT $$", "kill -KILL $$"]
    ) {
      const directory = join(root, crypto.randomUUID());
      await Deno.mkdir(directory);
      const wrapper = join(directory, "time");
      await Deno.writeTextFile(wrapper, `#!/bin/sh\n${bootstrap}\n`);
      await Deno.chmod(wrapper, 0o755);
      await assert.rejects(
        () =>
          runOwnedProcess({
            executable: "/bin/sh",
            args: ["-c", `printf native > '${directory}/native'`],
            cwd: directory,
            env: Deno.env.toObject(),
            stdoutPath: join(directory, "out"),
            stderrPath: join(directory, "err"),
            timeExecutable: wrapper,
            stdout: new WritableStream({ write() {} }),
            stderr: new WritableStream({ write() {} }),
          }),
        (error: unknown) => {
          assert(error instanceof OwnedProcessError);
          assert.equal(error.outcome, undefined);
          assert.match(error.message, /подтверждённого результата/);
          return true;
        },
      );
      await assert.rejects(() => Deno.stat(join(directory, "native")), Deno.errors.NotFound);
      assert.equal(await Deno.readTextFile(join(directory, "out")), "");
      assert.equal(await Deno.readTextFile(join(directory, "err")), "");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("native render does not report a missing executable as a completed build", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf-missing-native-" });
  try {
    await assert.rejects(
      () =>
        runNativeRender({
          quarto: join(root, "missing-quarto"),
          nativeArgv: [],
          cwd: root,
          mode: "off",
        }, root),
      (error: unknown) => {
        assert(error instanceof OwnedProcessError);
        assert.equal(error.outcome, undefined);
        return true;
      },
    );
    assert.match(await Deno.readTextFile(join(root, "stderr.log")), /No such file/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
