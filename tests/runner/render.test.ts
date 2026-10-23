import { strict as assert } from "node:assert";
import { join } from "node:path";

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
    const request = {
      cwd: root,
      quarto: executable,
      nativeArgv: ["file space.qmd", "--", "--help"],
      mode: "off",
    };
    const module = new URL("../../src/runner/render.ts", import.meta.url).href;
    const source = `import {runNativeRender} from ${
      JSON.stringify(module)
    };const result=await runNativeRender(${JSON.stringify(request)},${
      JSON.stringify(staging)
    },{QUARTO_PROFILE:"student"});await Deno.writeTextFile(${
      JSON.stringify(join(root, "result"))
    },JSON.stringify(result));`;
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["eval", source],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(output.success, new TextDecoder().decode(output.stderr));
    const result = JSON.parse(await Deno.readTextFile(join(root, "result")));
    assert.equal(new TextDecoder().decode(output.stdout), "render\nfile space.qmd\n--\n--help\n");
    assert.equal(new TextDecoder().decode(output.stderr), `${root}\nstudent\n`);
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
