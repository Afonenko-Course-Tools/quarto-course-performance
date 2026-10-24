import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { NativeRenderRequest } from "../../src/report/types.ts";

import { resolveRenderProject } from "../../src/adapters/quarto/inspect.ts";

Deno.test("public inspect resolves cwd, subfolder, nested and foreign projects without changing argv", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf project spaces " });
  try {
    for (const dir of ["course", "course/sub", "course/nested", "other", "solo"]) {
      await Deno.mkdir(join(root, dir), { recursive: true });
      await Deno.writeTextFile(join(root, dir, "page.qmd"), "# Page\n");
    }
    await Deno.writeTextFile(join(root, "solo", "file with spaces.qmd"), "# Spaces\n");
    for (const dir of ["course", "course/nested", "other"]) {
      await Deno.writeTextFile(join(root, dir, "_quarto.yml"), "project:\n  type: default\n");
    }
    for (
      const [cwd, argv, expected, kind] of [
        ["course", [], "course", "project"],
        ["course", ["--execute-daemon-restart", "page.qmd"], "course", "project"],
        ["course", ["page.qmd", "--unknown", "value"], "course", "project"],
        ["course", ["--unknown=value", "page.qmd"], "course", "project"],
        ["course", ["--execute-daemon", "300"], "course", "project"],
        ["course", ["--execute-daemon", "300", "page.qmd"], "course", "project"],
        ["course", ["--execute-daemon", "page.qmd"], "course", "project"],
        ["course/sub", [], "course", "project"],
        ["course/nested", [], "course/nested", "project"],
        ["course", ["../other/page.qmd"], "other", "project"],
        ["course", ["nested/page.qmd"], "course/nested", "project"],
        ["course", ["../solo/page.qmd"], "solo", "standalone"],
        ["course", ["../solo/file with spaces.qmd"], "solo", "standalone"],
        ["course", ["--to", "html", "--output-dir", "site with spaces"], "course", "project"],
        ["course/sub", ["--to=html", "--output-dir=out"], "course", "project"],
        ["course", ["page.qmd", "--toc", "--metadata=title:literal $()"], "course", "project"],
      ] as const
    ) {
      const request: NativeRenderRequest = {
        cwd: join(root, cwd),
        quarto: "quarto",
        nativeArgv: [...argv],
        mode: "off",
      };
      const before = JSON.stringify(request);
      assert.deepEqual(await resolveRenderProject(request), {
        projectRoot: join(root, expected),
        kind,
        ...(argv.some((arg) => arg === "--output-dir")
          ? { outputDirectory: join(root, expected, "site with spaces") }
          : argv.some((arg) => arg === "--output-dir=out")
          ? { outputDirectory: join(root, expected, "out") }
          : {}),
      });
      assert.equal(JSON.stringify(request), before);
    }
    await assert.rejects(
      () =>
        resolveRenderProject({
          cwd: root,
          quarto: "quarto",
          nativeArgv: ["course/page.qmd", "other/page.qmd"],
          mode: "off",
        }),
      /неоднознач|одн[аоу].*цел/i,
    );
    await assert.rejects(
      () =>
        resolveRenderProject({
          cwd: root,
          quarto: "quarto",
          nativeArgv: ["--include-after-body", "course/page.qmd"],
          mode: "off",
        }),
      /неоднознач/i,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("inspect receives argv and environment profiles while render-only options stay native", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf profile " });
  const previous = Deno.env.get("QUARTO_PROFILE");
  try {
    await Deno.writeTextFile(join(root, "_quarto.yml"), "project:\n  type: default\n");
    await Deno.writeTextFile(join(root, "page.qmd"), "# Page\n");
    // An invalid profile must be observed by inspect, not silently discarded.
    await Deno.writeTextFile(join(root, "_quarto-broken.yml"), "project: [invalid]\n");
    const request: NativeRenderRequest = {
      cwd: root,
      quarto: "quarto",
      nativeArgv: ["--to", "html", "--profile", "broken"],
      mode: "off",
    };
    await assert.rejects(() => resolveRenderProject(request), /inspect|project/i);
    request.nativeArgv = ["--profile=broken", "page.qmd", "--output-dir=out"];
    await assert.rejects(() => resolveRenderProject(request), /inspect|project/i);
    Deno.env.set("QUARTO_PROFILE", "broken");
    request.nativeArgv = [];
    await assert.rejects(() => resolveRenderProject(request), /inspect|project/i);
    request.nativeArgv = ["--profile", "valid"];
    await Deno.writeTextFile(join(root, "_quarto-valid.yml"), "project:\n  type: default\n");
    assert.deepEqual(await resolveRenderProject(request), { projectRoot: root, kind: "project" });
  } finally {
    if (previous === undefined) Deno.env.delete("QUARTO_PROFILE");
    else Deno.env.set("QUARTO_PROFILE", previous);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("inspect normalizes leading-dash targets without changing native render argv", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "--help"));
    await Deno.writeTextFile(join(root, "--help/_quarto.yml"), "project:\n  type: default\n");
    await Deno.writeTextFile(join(root, "--help/a.qmd"), "# Test\n");
    const request: NativeRenderRequest = {
      cwd: root,
      quarto: "/usr/bin/quarto",
      nativeArgv: ["--", "--help"],
      mode: "off",
    };
    assert.deepEqual(await resolveRenderProject(request), {
      projectRoot: join(root, "--help"),
      kind: "project",
    });
    assert.deepEqual(request.nativeArgv, ["--", "--help"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
