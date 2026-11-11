import { strict as assert } from "node:assert";
import { join } from "node:path";
import { compareOutputs } from "../src/analysis/outputs.ts";
import { preparePandocData } from "../src/launchers/setup.ts";
import { prepareRenderDiagnostic } from "../src/runner/diagnostic.ts";
import { installPackages } from "../src/sources/packages.ts";

// Запрет digest отличает функциональные операции от повторного доказательства bytes.
Deno.test("подготовка init, установка выбранных файлов и сравнение результата обходятся без digest", async () => {
  const root = await Deno.makeTempDir();
  const digest = crypto.subtle.digest;
  let calls = 0;
  crypto.subtle.digest = () => {
    calls++;
    throw new Error("Собственный digest запрещён");
  };
  try {
    await Deno.mkdir(join(root, "data"));
    await Deno.writeTextFile(join(root, "data/init.lua"), "return 'исходный init'\n");
    await preparePandocData(join(root, "data"), join(root, "prepared"), "/agent/init.lua");
    const init = await Deno.readTextFile(join(root, "prepared/init.lua"));
    assert(init.includes("/agent/init.lua"));
    assert.equal(await Deno.readTextFile(join(root, "data/init.lua")), "return 'исходный init'\n");
    await Deno.mkdir(join(root, "owner/_extensions/core"), { recursive: true });
    await Deno.writeTextFile(join(root, "owner/_extensions/core/_extension.yml"), "version: 2\n");
    await Deno.mkdir(join(root, "course/_extensions/core"), { recursive: true });
    await Deno.writeTextFile(join(root, "course/_extensions/core/_extension.yml"), "version: 1\n");
    await installPackages(join(root, "course"), [{
      repository: "org/core",
      sha: "a".repeat(40),
      checkoutPath: join(root, "owner"),
    }], [{ repository: "org/core", extensionId: "core", destinations: ["_extensions/core"] }]);
    assert.equal(
      await Deno.readTextFile(join(root, "course/_extensions/core/_extension.yml")),
      "version: 2\n",
    );
    assert.equal(
      (await compareOutputs(
        join(root, "owner/_extensions/core"),
        join(root, "course/_extensions/core"),
      )).equivalent,
      true,
    );
    await Deno.writeTextFile(join(root, "course/_extensions/core/_extension.yml"), "version: 3\n");
    assert.equal(
      (await compareOutputs(
        join(root, "owner/_extensions/core"),
        join(root, "course/_extensions/core"),
      )).equivalent,
      false,
    );
    assert.equal(calls, 0);
  } finally {
    crypto.subtle.digest = digest;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("обычная подготовка summary выбранного runtime не вычисляет digest", async () => {
  const root = await Deno.makeTempDir();
  const digest = crypto.subtle.digest;
  let calls = 0;
  crypto.subtle.digest = () => {
    calls++;
    throw new Error("Собственный digest запрещён");
  };
  try {
    const result = await prepareRenderDiagnostic(
      { cwd: root, quarto: Deno.env.get("QUARTO") ?? "quarto", nativeArgv: [], mode: "summary" },
      { projectRoot: root, kind: "standalone" },
      join(root, "diagnostic"),
    );
    assert.equal(calls, 0);
    assert.equal(result.coverage.complete, false);
    assert(result.preparedScripts.length > 0);
    assert(result.preparedScripts[0]);
    assert.deepEqual(Object.keys(result.preparedScripts[0]).sort(), ["kind", "path"]);
    assert.equal((await Deno.stat(result.preparedScripts[0].path)).isFile, true);
  } finally {
    crypto.subtle.digest = digest;
    await Deno.remove(root, { recursive: true });
  }
});
