import { strict as assert } from "node:assert";
import { join } from "node:path";
import { syncBridge } from "../../tools/sync-bridge.ts";

Deno.test("owner sync uses only installed implementation languages and checks their bytes", async () => {
  const root = await Deno.makeTempDir();
  try {
    const pairs = [
      ["core", "course-core", ["ts", "lua"]],
      ["print", "course-print", ["ts"]],
      ["moodle", "course-moodle", ["ts"]],
      ["cloud", "course-cloud", ["lua"]],
    ] as const;
    const roots: string[] = [];
    for (const [owner, extension, languages] of pairs) {
      const checkout = join(root, owner), path = join(checkout, "_extensions", extension);
      await Deno.mkdir(path, { recursive: true });
      for (const language of languages) {
        await Deno.writeTextFile(join(path, "implementation." + language), "// fixture");
      }
      roots.push(checkout);
    }
    await syncBridge(roots, false);
    for (const [owner, extension, languages] of pairs) {
      const observation = join(root, owner, "_extensions", extension, "observability");
      const names = [];
      for await (const entry of Deno.readDir(observation)) names.push(entry.name);
      assert.deepEqual(names.sort(), languages.map((language) => "bridge." + language).sort());
    }
    await syncBridge(roots, true);
    const print = join(root, "print", "_extensions/course-print/observability/bridge.ts");
    await Deno.writeTextFile(print, "drift");
    await assert.rejects(() => syncBridge(roots, true), /ABI drift/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("owner check permits functional clocks and rejects legacy protocol, incomplete roots and extra bridge language", async () => {
  const temporary = await Deno.makeTempDir();
  const registry = JSON.parse(
    await Deno.readTextFile(new URL("../../docs/operation-registry.json", import.meta.url)),
  );
  const owners = [
    ["core", ["course-core", "course-presentation", "course-navigation"]],
    ["site", ["course-site"]],
    ["qrc", ["reference-catalog"]],
    ["download", ["project-download"]],
    ["pl", ["course-prairielearn"]],
    ["print", ["course-print"]],
    ["moodle", ["course-moodle"]],
    ["cloud", ["course-cloud"]],
  ] as const;
  try {
    const roots = owners.map(([name]) => join(temporary, name));
    for (const [name, extensions] of owners) {
      for (const extension of extensions) {
        const path = join(temporary, name, "_extensions", extension);
        await Deno.mkdir(path, { recursive: true });
        for (
          const entry of registry.filter((row: { extension: string }) =>
            row.extension === extension
          )
        ) {
          const destination = join(path, entry.path);
          await Deno.mkdir(join(destination, ".."), { recursive: true });
          await Deno.writeTextFile(destination, entry.operation.replace(/\*$/, "") + "\n", {
            append: true,
          });
        }
      }
    }
    await syncBridge(roots, false);
    const check = async (paths: string[]) => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          new URL("../../tools/check-owners.ts", import.meta.url).pathname,
          ...paths,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        success: result.success,
        text: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
      };
    };
    const functionalClock = join(roots[5], "_extensions/course-print/functional-clock.ts");
    await Deno.writeTextFile(
      functionalClock,
      "export const build = () => { const started = performance.now(); return {timings: {staging: performance.now() - started}}; };",
    );
    const complete = await check(roots);
    assert(complete.success, complete.text);
    const legacy = join(roots[2], "_extensions/reference-catalog/legacy-protocol.ts");
    // Actual QRC fec4e1a protocol: env-selected append-only command timing output.
    await Deno.writeTextFile(
      legacy,
      `const path = Deno.env.get("COURSE_BUILD_TRACE");
if (path) await Deno.writeTextFile(path, JSON.stringify({kind: "render", elapsedMs: performance.now()}) + "\\n", {append: true});`,
    );
    const forbidden = await check(roots);
    assert.equal(forbidden.success, false, "check accepted the removed command trace protocol");
    assert.match(forbidden.text, /Legacy telemetry: .*legacy-protocol\.ts/);
    await Deno.remove(legacy);
    const incomplete = await check(roots.slice(0, 5));
    assert.equal(incomplete.success, false, "check accepted only five old owners");
    assert.match(incomplete.text, /8 checkouts/);
    const extra = join(roots[5], "_extensions/course-print/observability/bridge.lua");
    await Deno.copyFile(new URL("../../bridge/bridge.lua", import.meta.url), extra);
    const unexpected = await check(roots);
    assert.equal(unexpected.success, false);
    assert.match(unexpected.text, /лишние observability/);
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
});
