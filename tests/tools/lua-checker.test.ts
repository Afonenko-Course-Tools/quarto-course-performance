import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../../tools/check-lua.ts", import.meta.url));
async function invoke(args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-config", "--no-lock", "-A", checker, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    ...result,
    text: new TextDecoder().decode(result.stdout),
    error: new TextDecoder().decode(result.stderr),
  };
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
  const bootstrap = fileURLToPath(new URL("../../tools/setup-lua-ci.sh", import.meta.url));
  try {
    const fake = root + "/bin";
    await Deno.mkdir(fake);
    await Deno.writeTextFile(
      fake + "/curl",
      `#!/bin/sh\ntouch '${root}/network-called'\nexit 99\n`,
    );
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
        stdout: "piped",
        stderr: "piped",
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

function diagnosticFiles(output: string): string[] {
  const parsed: unknown = JSON.parse(output);
  if (Array.isArray(parsed)) {
    assert.deepEqual(parsed, []);
    return [];
  }
  assert(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return Object.keys(parsed);
}
const faultyLua =
  "---@param value unknown\nlocal function identity(value)\n local copy=value\n return copy\nend\nreturn identity\n";
Deno.test("Lua checker сохраняет выбранный own/tests при соседнем корневом tests", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(root + "/own/tests", { recursive: true });
    await Deno.mkdir(root + "/tests");
    await Deno.writeTextFile(root + "/own/tests/unknown.lua", faultyLua);
    await Deno.writeTextFile(root + "/tests/outside.lua", faultyLua);
    const result = await invoke(["--root", root, "--scope", "own"]);
    assert.equal(result.success, false, "Ошибочный выбранный файл получил ложный PASS");
    const files = diagnosticFiles(result.text);
    assert(files.some((path) => path.endsWith("/own/tests/unknown.lua")));
    assert(!files.some((path) => path.endsWith("/tests/outside.lua")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
for (const mechanism of ["gitignore", "info-exclude", "submodule"]) {
  Deno.test(`Lua checker сохраняет явный own scope при ${mechanism}`, async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(root + "/own");
      await Deno.mkdir(root + "/.git/info", { recursive: true });
      await Deno.writeTextFile(root + "/own/unknown.lua", faultyLua);
      if (mechanism === "gitignore") await Deno.writeTextFile(root + "/.gitignore", "own/\n");
      if (mechanism === "info-exclude") {
        await Deno.writeTextFile(root + "/.git/info/exclude", "own/\n");
      }
      if (mechanism === "submodule") {
        await Deno.writeTextFile(root + "/.gitmodules", '[submodule "own"]\n path = own\n');
      }
      const result = await invoke(["--root", root, "--scope", "own"]);
      assert.equal(result.success, false, "Git metadata скрыли весь проверяемый состав");
      assert(diagnosticFiles(result.text).some((path) => path.endsWith("/own/unknown.lua")));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("Lua checker разрешает выбранный typed require через runtime-path", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(root + "/own/presentation/modules", { recursive: true });
    await Deno.writeTextFile(
      root + "/own/presentation/modules/leaf.lua",
      "---@param value number\n---@return number\nreturn function(value) return value+1 end\n",
    );
    await Deno.writeTextFile(
      root + "/own/main.lua",
      "local leaf=require('leaf')\nreturn leaf('wrong-type')\n",
    );
    const result = await invoke([
      "--root",
      root,
      "--scope",
      "own",
      "--runtime-path",
      "own/presentation/?.lua",
      "--runtime-path",
      "own/presentation/modules/?.lua",
    ]);
    assert.equal(result.success, false);
    assert(diagnosticFiles(result.text).some((path) => path.endsWith("/own/main.lua")));
    assert.match(result.text, /param-type-mismatch/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Lua bridge сохраняет узкий walk ABI с тремя одинаковыми копиями", async () => {
  const root = await Deno.makeTempDir();
  const bridge = await Deno.readTextFile(new URL("../../bridge/bridge.lua", import.meta.url));
  try {
    for (const owner of ["one", "two", "three"]) {
      await Deno.mkdir(`${root}/own/${owner}`, { recursive: true });
      await Deno.writeTextFile(`${root}/own/${owner}/bridge.lua`, bridge);
    }
    const caller = `---@param value number
---@return number
local function callback(value) return value+1 end
local one=require('own.one.bridge').create_metrics('one')
local two=require('own.two.bridge').create_metrics('two')
local three=require('own.three.bridge').create_metrics('three')
local first=one.wrap_walk({id='one',kind='ast_walk',scope='fragment'},callback)
local second=two.wrap_walk({id='two',kind='ast_walk',scope='block'},callback)
local third=three.wrap_walk({id='three',kind='ast_walk',scope='inline'},callback)
assert(first(1)==2 and second(2)==3 and third(3)==4)
`;
    await Deno.writeTextFile(root + "/own/main.lua", caller);
    const valid = await invoke(["--root", root, "--scope", "own"]);
    assert(valid.success, valid.error + valid.text);
    assert.deepEqual(diagnosticFiles(valid.text), []);
    await Deno.writeTextFile(
      root + "/own/main.lua",
      caller.replace("id='one',kind='ast_walk'", "id='one',kind='function'"),
    );
    const invalid = await invoke(["--root", root, "--scope", "own"]);
    assert.equal(invalid.success, false);
    const files = diagnosticFiles(invalid.text);
    assert.equal(files.length, 1);
    assert(files[0]?.endsWith("/own/main.lua"));
    const diagnostics: unknown = JSON.parse(invalid.text);
    assert(diagnostics !== null && typeof diagnostics === "object" && !Array.isArray(diagnostics));
    for (const entries of Object.values(diagnostics)) {
      assert(Array.isArray(entries));
      assert.equal(entries.length, 1);
      for (const entry of entries) {
        const diagnostic: unknown = entry;
        assert(diagnostic !== null && typeof diagnostic === "object" && "code" in diagnostic);
        assert.equal(diagnostic.code, "assign-type-mismatch");
        assert("range" in diagnostic && "message" in diagnostic);
        assert.deepEqual(diagnostic.range, {
          start: { line: 6, character: 36 },
          end: { line: 6, character: 40 },
        });
        assert(typeof diagnostic.message === "string");
        assert.match(diagnostic.message, /Literal `"function"` cannot match string `"ast_walk"`/);
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
