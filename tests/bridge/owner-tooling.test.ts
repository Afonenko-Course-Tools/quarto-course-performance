import { strict as assert } from "node:assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { array, object, parseJson, string } from "../../src/json.ts";

Deno.test("owner check permits functional clocks and rejects legacy protocol, incomplete roots", async () => {
  const temporary = await Deno.makeTempDir();
  const registry = parseJson(
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
          const entry of array(registry).map((row) => object(row)).filter((row) =>
            row.extension === extension
          )
        ) {
          const destination = join(path, string(entry.path));
          await Deno.mkdir(join(destination, ".."), { recursive: true });
          await Deno.writeTextFile(destination, string(entry.operation).replace(/\*$/, "") + "\n", {
            append: true,
          });
        }
      }
    }
    const check = async (paths: string[]) => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          fileURLToPath(new URL("../../tools/check-owners.ts", import.meta.url)),
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
    const functionalClock = join(string(roots[5]), "_extensions/course-print/functional-clock.ts");
    await Deno.writeTextFile(
      functionalClock,
      "export const build = () => { const started = performance.now(); return {timings: {staging: performance.now() - started}}; };",
    );
    const complete = await check(roots);
    assert(complete.success, complete.text);
    const legacy = join(string(roots[2]), "_extensions/reference-catalog/legacy-protocol.ts");
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
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
});
