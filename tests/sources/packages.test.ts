import { strict as assert } from "node:assert";
import { join } from "node:path";
import { installPackages } from "../../src/sources/packages.ts";
import { copyTree } from "../../src/sources/snapshot.ts";

Deno.test("runtime copy materializes internal file links and rejects external targets", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "runtime"));
    await Deno.writeTextFile(join(root, "runtime/AGENTS.md"), "original");
    await Deno.symlink("AGENTS.md", join(root, "runtime/CLAUDE.md"));
    await copyTree(join(root, "runtime"), join(root, "copy"), { materializeFileLinks: true });
    assert.equal(await Deno.readTextFile(join(root, "copy/CLAUDE.md")), "original");
    assert(!(await Deno.lstat(join(root, "copy/CLAUDE.md"))).isSymlink);
    await Deno.writeTextFile(join(root, "outside"), "private");
    await Deno.symlink("../outside", join(root, "runtime/escape"));
    await assert.rejects(
      () => copyTree(join(root, "runtime"), join(root, "other"), { materializeFileLinks: true }),
      /вне|escape/i,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("installs_all_subproject_copies and records identical owner hashes", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf packages " });
  try {
    const owner = join(root, "owner/_extensions/core");
    await Deno.mkdir(owner, { recursive: true });
    await Deno.writeTextFile(join(owner, "_extension.yml"), "version: 1\n");
    await Deno.writeTextFile(join(owner, "filter.lua"), "return {}\n");
    const course = join(root, "course");
    for (const prefix of ["", "child one/", "child two/"]) {
      const path = join(course, prefix, "_extensions/org/core");
      await Deno.mkdir(path, { recursive: true });
      await Deno.writeTextFile(join(path, "_extension.yml"), "version: old\n");
    }
    const receipts = await installPackages(course, [{
      repository: "org/owner",
      sha: "a".repeat(40),
      checkoutPath: join(root, "owner"),
    }], [{
      repository: "org/owner",
      extensionId: "core",
      destinations: [
        "_extensions/org/core",
        "child one/_extensions/org/core",
        "child two/_extensions/org/core",
      ],
    }]);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].destinationPaths.length, 3);
    assert.match(receipts[0].packageHash, /^[0-9a-f]{64}$/);
    for (const dest of receipts[0].destinationPaths) {
      assert.equal(await Deno.readTextFile(join(dest, "filter.lua")), "return {}\n");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rejects symlink escape before replacing any installation", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "owner/_extensions/core"), { recursive: true });
    await Deno.writeTextFile(join(root, "owner/_extensions/core/_extension.yml"), "version: 1");
    await Deno.mkdir(join(root, "outside/org/core"), { recursive: true });
    await Deno.writeTextFile(join(root, "outside/org/core/_extension.yml"), "original");
    await Deno.mkdir(join(root, "course"));
    await Deno.symlink(join(root, "outside"), join(root, "course/_extensions"));
    await assert.rejects(
      () =>
        installPackages(join(root, "course"), [{
          repository: "org/owner",
          sha: "a".repeat(40),
          checkoutPath: join(root, "owner"),
        }], [{
          repository: "org/owner",
          extensionId: "core",
          destinations: ["_extensions/org/core"],
        }]),
      /symlink|символическ/i,
    );
    assert.equal(
      await Deno.readTextFile(join(root, "outside/org/core/_extension.yml")),
      "original",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("explicit replacements preserve third party packages and validate all destinations before mutation", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (
      const path of [
        "owner/_extensions/core",
        "course/_extensions/org/core",
        "course/_extensions/third/extra",
      ]
    ) {
      await Deno.mkdir(join(root, path), { recursive: true });
      await Deno.writeTextFile(join(root, path, "_extension.yml"), path);
    }
    const course = join(root, "course"),
      owners = [{
        repository: "org/owner",
        sha: "a".repeat(40),
        checkoutPath: join(root, "owner"),
      }];
    const mapping = {
      repository: "org/owner",
      extensionId: "core",
      destinations: ["_extensions/org/core"],
    };
    assert.deepEqual(await installPackages(course, owners, []), []);
    for (
      const invalid of [[mapping, mapping], [mapping, {
        ...mapping,
        destinations: ["../owner/_extensions/core"],
      }], [mapping, { ...mapping, destinations: ["_extensions/org/core/child"] }]]
    ) {
      await assert.rejects(() => installPackages(course, owners, invalid));
      assert.equal(
        await Deno.readTextFile(join(course, "_extensions/org/core/_extension.yml")),
        "course/_extensions/org/core",
      );
    }
    await Deno.mkdir(join(root, "outside"));
    await Deno.writeTextFile(join(root, "outside/_extension.yml"), "outside");
    await Deno.symlink(join(root, "outside"), join(course, "_extensions/linked"));
    await assert.rejects(
      () =>
        installPackages(course, owners, [mapping, {
          ...mapping,
          destinations: ["_extensions/linked"],
        }]),
      /символическ/i,
    );
    assert.equal(
      await Deno.readTextFile(join(course, "_extensions/org/core/_extension.yml")),
      "course/_extensions/org/core",
    );
    await installPackages(course, owners, [mapping]);
    assert.equal(
      await Deno.readTextFile(join(course, "_extensions/third/extra/_extension.yml")),
      "course/_extensions/third/extra",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("new package receipts and replacement copies exclude prior source measurements", async () => {
  const root = await Deno.makeTempDir();
  try {
    const source = join(root, "owner/_extensions/core"), course = join(root, "course");
    await Deno.mkdir(join(source, ".quarto/course-perf"), { recursive: true });
    await Deno.writeTextFile(join(source, "_extension.yml"), "version: 2");
    await Deno.writeTextFile(join(source, ".quarto/course-perf/old.json"), "old measurement");
    await Deno.mkdir(join(course, "_extensions/core"), { recursive: true });
    await Deno.writeTextFile(join(course, "_extensions/core/_extension.yml"), "version: 1");
    const owners = [{
        repository: "org/owner",
        sha: "a".repeat(40),
        checkoutPath: join(root, "owner"),
      }],
      replacements = [{
        repository: "org/owner",
        extensionId: "core",
        destinations: ["_extensions/core"],
      }];
    const first = await installPackages(course, owners, replacements);
    await assert.rejects(
      () => Deno.stat(join(course, "_extensions/core/.quarto/course-perf")),
      Deno.errors.NotFound,
    );
    await Deno.writeTextFile(join(source, ".quarto/course-perf/old.json"), "new measurement");
    const second = await installPackages(course, owners, replacements);
    assert.equal(first[0].packageHash, second[0].packageHash);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
