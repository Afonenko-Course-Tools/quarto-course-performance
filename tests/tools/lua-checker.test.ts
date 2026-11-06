import { strict as assert } from "node:assert";

const checker = new URL("../../tools/check-lua.ts", import.meta.url).pathname;
async function invoke(args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-config", "--no-lock", "-A", checker, ...args],
    stdout: "piped", stderr: "piped",
  }).output();
  return { ...result, text: new TextDecoder().decode(result.stdout), error: new TextDecoder().decode(result.stderr) };
}
Deno.test("Lua checker отклоняет относительный root до запуска движка", async () => {
  const result = await invoke(["--root", "relative", "--scope", "bridge"]);
  assert.equal(result.success, false);
  assert.match(result.error, /--root.*абсолют/);
});
Deno.test("Lua checker canary видит own Lua и исключает vendor и чужой scope", async () => {
  const result = await invoke(["--probe"]);
  assert(result.success, result.error + result.text);
  const start = result.text.indexOf("{");
  const end = result.text.lastIndexOf("}");
  const diagnostics: unknown = JSON.parse(result.text.slice(start, end + 1));
  assert(diagnostics !== null && typeof diagnostics === "object");
  const files = Object.keys(diagnostics);
  assert(files.some((path) => path.endsWith("/own/unknown.lua")), "Не проверен own canary");
  assert(!files.some((path) => path.includes("/vendor/") || path.includes("/outside/")));
});

Deno.test("Lua bootstrap отклоняет относительный и существующий target до сети", async () => {
  const root = await Deno.makeTempDir();
  const bootstrap = new URL("../../tools/setup-lua-ci.sh", import.meta.url).pathname;
  try {
    const fake = root + "/bin";
    await Deno.mkdir(fake);
    await Deno.writeTextFile(fake + "/curl", `#!/bin/sh\ntouch '${root}/network-called'\nexit 99\n`);
    await Deno.chmod(fake + "/curl", 0o755);
    const existing = root + "/existing";
    await Deno.mkdir(existing);
    await Deno.writeTextFile(existing + "/keep", "сохранить");
    const dangling = root + "/dangling";
    await Deno.symlink(root + "/missing", dangling);
    for (const target of ["relative", existing, dangling]) {
      const result = await new Deno.Command("bash", {
        args: [bootstrap, target],
        env: { PATH: fake + ":" + (Deno.env.get("PATH") ?? "") },
        stdout: "piped", stderr: "piped",
      }).output();
      assert.equal(result.success, false);
      assert.match(new TextDecoder().decode(result.stderr), /новый абсолютный/);
      await assert.rejects(() => Deno.stat(root + "/network-called"), Deno.errors.NotFound);
    }
    assert.equal(await Deno.readTextFile(existing + "/keep"), "сохранить");
    assert.equal(await Deno.readLink(dangling), root + "/missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
