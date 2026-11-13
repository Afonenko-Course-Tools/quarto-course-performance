import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../", import.meta.url));
const decoder = new TextDecoder();
Deno.test("Arch recipe packages runtime assets and installed CLI from the real package()", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf makepkg " });
  try {
    const version = (await Deno.readTextFile(join(source, "VERSION"))).trim();
    await Deno.symlink(source, join(root, "quarto-course-performance-" + version));
    const pkgdir = join(root, "package");
    const result = await new Deno.Command("bash", {
      args: ["-eu", "-c", "source packaging/arch/PKGBUILD; package"],
      cwd: source,
      env: { srcdir: root, pkgdir },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 0, decoder.decode(result.stderr));
    const app = join(pkgdir, "usr/lib/quarto-course-perf");
    for (
      const path of [
        "src/cli.ts",
        "bridge/bridge.ts",
        "bridge/bridge.lua",
        "deno.json",
        "deno.lock",
        "docs/operation-registry.json",
      ]
    ) {
      assert((await Deno.stat(join(app, path))).isFile, path);
    }
    const launcher = join(pkgdir, "usr/bin/quarto-course-perf");
    const mode = (await Deno.stat(launcher)).mode;
    assert(mode !== null && (mode & 0o111) !== 0);
    const installed = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "tools/check-installed.ts", "--root", app],
      cwd: source,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(
      installed.code,
      0,
      decoder.decode(installed.stdout) + decoder.decode(installed.stderr),
    );
    assert(
      (await Deno.stat(join(pkgdir, "usr/share/doc/quarto-course-perf/scenarios/java.json")))
        .isFile,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Arch recipe checker rejects a missing checksum and an unknown shell variable", async () => {
  const root = await Deno.makeTempDir();
  try {
    const original = await Deno.readTextFile(join(source, "packaging/arch/PKGBUILD"));
    const recipe = join(root, "PKGBUILD");
    await Deno.writeTextFile(recipe, original.replace("sha256sums=('')", "sha256sums=()"));
    const invalid = await new Deno.Command("bash", {
      args: ["tools/check-packaging.sh", recipe],
      cwd: source,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.notEqual(invalid.code, 0, "Несогласованный makepkg source/checksum получил PASS");
    await Deno.writeTextFile(recipe, original + "\nmisspelled_makepkg_variable=1\n");
    const shell = await new Deno.Command("shellcheck", {
      args: [recipe],
      cwd: dirname(recipe),
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.notEqual(shell.code, 0);
    assert.match(decoder.decode(shell.stdout), /SC2034.*|misspelled_makepkg_variable/s);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
