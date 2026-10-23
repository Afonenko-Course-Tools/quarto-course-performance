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

async function fakeNative(check: (quarto: string) => Promise<void>) {
  const root = await Deno.makeTempDir();
  try {
    const quarto = join(root, "quarto");
    await Deno.writeTextFile(quarto, "#!/bin/sh\nprintf '<%s>\\n' \"$@\"\nexit 7\n");
    await Deno.chmod(quarto, 0o755);
    await check(quarto);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("native help after a native separator reaches the native render argv", async () => {
  await fakeNative(async (quarto) => {
    await isolated(["render", "--", "--", "--help"], (_root, out) => {
      assert.equal(out.code, 7, decode(out.stderr));
      assert.equal(decode(out.stdout), "<render>\n<-->\n<--help>\n");
      assert.equal(decode(out.stderr), "");
    }, { QUARTO: quarto });
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

Deno.test("render off loads the real native path without experiment configuration or npm compiler", async () => {
  await fakeNative(async (quarto) => {
    await isolated(["render", "--perf-mode=off", "file space.qmd"], async (root, out) => {
      assert.equal(out.code, 7, decode(out.stderr));
      assert.equal(decode(out.stdout), "<render>\n<file space.qmd>\n");
      assert.equal(decode(out.stderr), "");
      assert.deepEqual(await Array.fromAsync(Deno.readDir(root)), []);
    }, { QUARTO: quarto });
  });
});
