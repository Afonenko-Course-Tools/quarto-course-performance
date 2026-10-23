import { strict as assert } from "node:assert";
import { join } from "node:path";
import { runNativeRender } from "../../src/runner/render.ts";
Deno.test("native render preserves argv cwd functional env and existing outputs", async () => {
  const root = await Deno.makeTempDir();
  try {
    const executable = join(root, "quarto"), staging = join(root, "staging");
    await Deno.writeTextFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$@"\nprintf '%s\\n' "$PWD" "$QUARTO_PROFILE" >&2\nexit 7\n`,
    );
    await Deno.chmod(executable, 0o755);
    await Deno.writeTextFile(join(root, "output"), "keep");
    const result = await runNativeRender(
      {
        cwd: root,
        quarto: executable,
        nativeArgv: ["file space.qmd", "--", "--help"],
        mode: "off",
      },
      staging,
      { QUARTO_PROFILE: "student" },
    );
    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
    assert.equal(
      await Deno.readTextFile(join(staging, "stdout.log")),
      "render\nfile space.qmd\n--\n--help\n",
    );
    assert.equal(await Deno.readTextFile(join(staging, "stderr.log")), `${root}\nstudent\n`);
    assert.equal(await Deno.readTextFile(join(root, "output")), "keep");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
