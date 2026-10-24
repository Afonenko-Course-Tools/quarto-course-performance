import { strict as assert } from "node:assert";
import { join } from "node:path";
import { checkJava, parseJavaArgs, preflightJava } from "../../tools/check-java-general-use.ts";

async function withoutCommands(action: () => Promise<void>) {
  const original = Deno.Command;
  let spawned = 0;
  Deno.Command = class {
    constructor() {
      spawned++;
      throw new Error("Unexpected subprocess during input rejection");
    }
  } as unknown as typeof Deno.Command;
  try {
    await action();
    assert.equal(spawned, 0);
  } finally {
    Deno.Command = original;
  }
}

Deno.test("Java parser requires an explicit replacement owner", () => {
  const args = ["--project", "/source", "--output", "/evidence"];
  assert.throws(() => parseJavaArgs(args), /--replacement-owner/);
  assert.throws(
    () => parseJavaArgs([...args, "--replacement-owner", "relative"]),
    /absolute|абсолют/,
  );
  assert.deepEqual(parseJavaArgs([...args, "--replacement-owner", "/owner"]), {
    project: "/source",
    output: "/evidence",
    replacementOwner: "/owner",
  });
  assert.throws(() =>
    parseJavaArgs([...args, "--replacement-owner", "/owner", "--output", "/other"])
  );
});

Deno.test("Java entry rejects missing and invalid owners before evidence or subprocesses", async () => {
  const root = await Deno.makeTempDir();
  try {
    const source = join(root, "source"), output = join(root, "evidence");
    await Deno.mkdir(source);
    await withoutCommands(async () => {
      for (const owner of [undefined, "relative", join(root, "missing"), source]) {
        await assert.rejects(() => checkJava(source, output, owner as string), /replacement-owner/);
        await assert.rejects(() => Deno.stat(output), Deno.errors.NotFound);
      }
    });
    assert.deepEqual(Array.from(Deno.readDirSync(source)), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

for (
  const form of [
    "equal",
    "trailing-source",
    "dotdot",
    "symlink-dotdot",
    "parent-alias",
    "source-alias",
    "output-alias",
  ]
) {
  Deno.test(`Java entry rejects source containment before writes or subprocesses: ${form}`, async () => {
    const root = await Deno.makeTempDir();
    try {
      const source = join(root, "source"), alias = join(root, "alias");
      await Deno.mkdir(source);
      await Deno.mkdir(join(source, "child"));
      await Deno.mkdir(join(root, "sibling"));
      await Deno.symlink(source, alias);
      let project = source, output = join(source, "evidence");
      if (form === "equal") output = source;
      if (form === "trailing-source") project += "/";
      if (form === "dotdot") output = root + "/sibling/../source/evidence";
      if (form === "symlink-dotdot") {
        await Deno.symlink(join(source, "child"), join(root, "child-alias"));
        output = root + "/child-alias/../evidence";
      }
      if (form === "parent-alias") output = join(alias, "evidence");
      if (form === "source-alias") project = alias;
      if (form === "output-alias") output = alias;
      await withoutCommands(async () => {
        await assert.rejects(() => checkJava(project, output, root), /вне source/);
      });
      assert.deepEqual(Array.from(Deno.readDirSync(source)).map((entry) => entry.name), ["child"]);
      assert.deepEqual(Array.from(Deno.readDirSync(join(source, "child"))), []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("Java preflight accepts separate canonical paths and a clean owner, rejects dirty owner", async () => {
  const root = await Deno.makeTempDir();
  try {
    const project = join(root, "source"),
      owner = join(root, "owner"),
      output = project + "-evidence";
    await Deno.mkdir(project);
    await Deno.mkdir(join(owner, "_extensions/reference-catalog"), { recursive: true });
    await Deno.writeTextFile(
      join(owner, "_extensions/reference-catalog/_extension.yml"),
      "title: fixture\n",
    );
    const git = async (args: string[]) => {
      const result = await new Deno.Command("git", {
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "-C",
          owner,
          ...args,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(result.success, new TextDecoder().decode(result.stderr));
    };
    await assert.rejects(() => preflightJava(project, output, owner), /replacement-owner/);
    await assert.rejects(() => Deno.stat(output), Deno.errors.NotFound);
    await git(["init"]);
    await assert.rejects(() => preflightJava(project, output, owner), /replacement-owner/);
    await assert.rejects(() => Deno.stat(output), Deno.errors.NotFound);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const alias = join(root, "source-alias");
    await Deno.symlink(project, alias);
    const result = await preflightJava(alias + "/", output, owner);
    assert.deepEqual(result, {
      project: await Deno.realPath(project),
      output,
      replacementOwner: await Deno.realPath(owner),
    });
    await assert.rejects(() => Deno.stat(output), Deno.errors.NotFound);
    const invalidPackageLink = join(owner, "_extensions/reference-catalog/linked-file");
    await Deno.symlink(
      join(owner, "_extensions/reference-catalog/_extension.yml"),
      invalidPackageLink,
    );
    await withoutCommands(async () => {
      await assert.rejects(() => checkJava(project, output, owner), /replacement-owner/);
    });
    await assert.rejects(() => Deno.stat(output), Deno.errors.NotFound);
    await Deno.remove(invalidPackageLink);
    await Deno.writeTextFile(join(owner, "untracked"), "dirty");
    await assert.rejects(() => preflightJava(project, output, owner), /clean/);
    await assert.rejects(() => Deno.stat(output), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
