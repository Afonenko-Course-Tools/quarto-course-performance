import { strict as assert } from "node:assert";
import { join } from "node:path";

const cli = new URL("../../src/cli.ts", import.meta.url).pathname;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function isolated(
  args: string[],
  check: (root: string, out: Deno.CommandOutput) => void | Promise<void>,
  env: Record<string, string> = {},
) {
  const root = await Deno.makeTempDir();
  try {
    const cwd = join(root, "project");
    await Deno.mkdir(cwd);
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--cached-only", "-A", cli, ...args],
      cwd,
      env: { DENO_DIR: join(root, "cache"), ...env },
      stdout: "piped",
      stderr: "piped",
    }).output();
    await check(cwd, out);
    try {
      assert.deepEqual(await Array.fromAsync(Deno.readDir(join(root, "cache", "npm"))), []);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("help and version need no Quarto, project, config, network or npm cache", async () => {
  for (const args of [[], ["--help"], ["help"], ["--version"]]) {
    await isolated(args, async (root, out) => {
      assert(out.success, decode(out.stderr));
      assert.match(decode(out.stdout), args[0] === "--version" ? /2\.0\.0/ : /quarto-course-perf/);
      assert.equal(decode(out.stderr), "");
      assert.deepEqual(await Array.fromAsync(Deno.readDir(root)), []);
    }, { PATH: "/nonexistent", QUARTO: "/nonexistent/quarto" });
  }
});

Deno.test("native render help bypasses project inspect and report staging", async () => {
  await isolated(
    ["render", "--perf-mode=cpu", "--perf-output=report", "--help"],
    async (root, out) => {
      assert(out.success, decode(out.stderr));
      assert.match(decode(out.stdout), /quarto render/);
      assert.deepEqual(await Array.fromAsync(Deno.readDir(root)), []);
    },
    { QUARTO: "/usr/bin/quarto" },
  );
});

Deno.test("native help after a native separator is not treated as a help request", async () => {
  await isolated(["render", "--", "--", "--help"], (_root, out) => {
    assert.doesNotMatch(decode(out.stdout), /quarto render/);
  });
});

Deno.test("experiment capabilities needs no Compiler API or npm cache", async () => {
  const project = new URL("../../", import.meta.url).pathname;
  await isolated(
    ["experiment", "capabilities", "--config", join(project, "scenarios/java.json")],
    (_root, out) => {
      assert(out.success, decode(out.stderr));
      const capabilities = JSON.parse(decode(out.stdout));
      assert(capabilities.runtime.quarto.version);
    },
    { QUARTO: "/usr/bin/quarto" },
  );
});

Deno.test("render off does not load experiment configuration or npm compiler", async () => {
  await isolated(["render", "--perf-mode=off", "missing.qmd"], (_root, out) => {
    assert.doesNotMatch(
      decode(out.stderr),
      /scenarios\/java\.json|npm:|Compiler API|Download|CLI параметр/,
    );
  }, { QUARTO: "/usr/bin/quarto" });
});
