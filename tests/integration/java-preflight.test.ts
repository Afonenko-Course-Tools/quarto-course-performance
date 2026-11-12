import { strict as assert } from "node:assert";
import { join } from "node:path";
import { checkJava, parseJavaArgs, preflightJava } from "../../tools/check-java-general-use.ts";

async function withoutCommands(action: () => Promise<void>) {
  const original = Deno.Command;
  let spawned = 0;
  Deno.Command = class extends original {
    constructor(...args: ConstructorParameters<typeof original>) {
      super(...args);
      spawned++;
      throw new Error("Unexpected subprocess during input rejection");
    }
  };
  try {
    await action();
    assert.equal(spawned, 0);
  } finally {
    Deno.Command = original;
  }
}

Deno.test("Java parser accepts explicit project and evidence paths", () => {
  const args = ["--project", "/source", "--output", "/evidence"];
  assert.deepEqual(parseJavaArgs(args), { project: "/source", output: "/evidence" });
  assert.throws(() => parseJavaArgs(["--project", "relative", "--output", "/evidence"]), /абсолют/);
  assert.throws(() => parseJavaArgs([...args, "--output", "/other"]));
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
        await assert.rejects(() => checkJava(project, output), /вне source/);
      });
      assert.deepEqual(Array.from(Deno.readDirSync(source)).map((entry) => entry.name), ["child"]);
      assert.deepEqual(Array.from(Deno.readDirSync(join(source, "child"))), []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("Java preflight accepts separate canonical paths without a companion owner", async () => {
  const root = await Deno.makeTempDir();
  try {
    const project = join(root, "source"), output = project + "-evidence";
    await Deno.mkdir(project);
    const alias = join(root, "alias");
    await Deno.symlink(project, alias);
    await withoutCommands(async () => {
      assert.deepEqual(await preflightJava(alias, output), { project, output });
    });
    await assert.rejects(() => Deno.stat(output), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
