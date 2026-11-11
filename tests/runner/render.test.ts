import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { parseObject } from "../../src/json.ts";

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
    const result = parseObject(await Deno.readTextFile(join(root, "result")));
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

Deno.test("preparedScripts отклоняет старые proof поля и сохраняет действительные пути", async () => {
  const { validatePreparedScript } = await import("../../src/config/types.ts");
  const input = {
    kind: "bootstrap",
    path: "/fixture/bootstrap",
    sourceHash: "a",
    preparedHash: "b",
    extra: { owner: "preparedScripts" },
  };
  assert.throws(() => validatePreparedScript(input), /proof поля/);
  assert.deepEqual(validatePreparedScript({ kind: "bootstrap", path: "/fixture/bootstrap" }), {
    kind: "bootstrap",
    path: "/fixture/bootstrap",
  });
});

Deno.test("custom native Pandoc data-dir receipts survive render report admission", async () => {
  const root = await Deno.makeTempDir({ prefix: "render custom pandoc data " });
  try {
    const data = join(root, "custom-data");
    await Deno.mkdir(data);
    await Deno.writeTextFile(join(data, "init.lua"), "CUSTOM_DATA_INITIALIZED=true\n");
    await Deno.writeTextFile(
      join(root, "index.qmd"),
      `---\ntitle: Custom data\nformat:\n  html:\n    embed-resources: true\n    pandoc-args:\n      - ${
        JSON.stringify("--data-dir=" + data)
      }\n---\n\nNative custom data content.\n`,
    );
    const cli = new URL("../../src/cli.ts", import.meta.url);
    const configuration = new URL("../../deno.json", import.meta.url);
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        fileURLToPath(configuration),
        "--cached-only",
        "-A",
        fileURLToPath(cli),
        "render",
        "--perf-mode",
        "summary",
        "--perf-output",
        join(root, "reports"),
        "index.qmd",
      ],
      cwd: root,
      env: { XDG_CACHE_HOME: join(root, "cache") },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(output.code, 0, new TextDecoder().decode(output.stderr));
    assert.match(await Deno.readTextFile(join(root, "index.html")), /Native custom data content/);
    const reports = [];
    for await (const entry of Deno.readDir(join(root, "reports"))) reports.push(entry.name);
    assert.equal(reports.length, 1);
    const record = parseObject(
      await Deno.readTextFile(join(root, "reports", reports[0]!, "run.json")),
    );
    assert.equal(record.dataValid, true);
    assert.equal((record.outcome as Record<string, unknown>).code, 0);
    assert(Array.isArray(record.preparedScripts));
    assert(
      record.preparedScripts.some((value) =>
        typeof value === "object" && value !== null && "path" in value &&
        typeof value.path === "string" && value.path.includes("pandoc-data/")
      ),
    );
    for (const receipt of record.preparedScripts) {
      assert.deepEqual(Object.keys(receipt).sort(), ["kind", "path"]);
    }
    assert.equal(await Deno.readTextFile(join(data, "init.lua")), "CUSTOM_DATA_INITIALIZED=true\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
