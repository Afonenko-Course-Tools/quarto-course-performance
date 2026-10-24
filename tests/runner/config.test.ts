import { quarto as nativeQuarto } from "../runtime.ts";
import { strict as assert } from "node:assert";
import { validateConfig } from "../../src/config/validate.ts";
Deno.test("config rejects unknown modes, escaped cwd, duplicate scenarios and missing explicit ref", () => {
  const s = {
    id: "one",
    cwd: ".",
    executable: "quarto",
    args: ["render", "--profile", "student"],
    cachePolicy: "clean-output",
    mode: "off",
    scope: { modules: [], extensions: [], strict: true },
    resources: { wall: true, cpu: true, peakRss: true },
  };
  const cfg = {
    schema_version: 2,
    projectSource: "org/Other",
    replacements: [],
    sources: [{ repository: "org/Other", refPolicy: "remote-default-head" }],
    scenarios: [s],
  };
  assert.equal(validateConfig(cfg).scenarios[0].id, "one");
  for (
    const bad of [
      { ...cfg, scenarios: [{ ...s, mode: "invalid" }] },
      { ...cfg, scenarios: [{ ...s, cwd: "../escape" }] },
      { ...cfg, scenarios: [s, s] },
      { ...cfg, sources: [{ repository: "org/Other", refPolicy: "explicit-remote-ref" }] },
    ]
  ) assert.throws(() => validateConfig(bad));
});

Deno.test("v2 config defaults to strict outputs and ten pairs; explicit benchmark threshold is mandatory", () => {
  const scenario = {
    id: "custom",
    cwd: ".",
    executable: "quarto",
    args: ["render", "--profile", "custom"],
    cachePolicy: "repeat-render",
    mode: "off",
    scope: { modules: [], extensions: [], strict: true },
    resources: { wall: true, cpu: true, peakRss: true },
  };
  const config = {
    schema_version: 2,
    sources: [{ repository: "org/Other", refPolicy: "remote-default-head" }],
    projectSource: "org/Other",
    replacements: [],
    scenarios: [scenario],
  };
  assert.equal(validateConfig(config).outputPolicy, "strict");
  assert.equal(
    validateConfig({ ...config, benchmark: { maxSlowdownRatio: 1.2 } }).benchmark?.pairs,
    10,
  );
  for (
    const change of [
      { schema_version: 1 },
      { projectSource: "org/Missing" },
      { benchmark: {} },
      { benchmark: { maxSlowdownRatio: 0 } },
      { benchmark: { maxSlowdownRatio: 1.1, pairs: 0 } },
      { outputPolicy: "unknown" },
      { scenarios: [{ ...scenario, project: "Java" }] },
    ]
  ) assert.throws(() => validateConfig({ ...config, ...change }));
});

Deno.test("experiment capabilities works outside a project without config, Git, unzip or Hyperfine", async () => {
  const root = await Deno.makeTempDir();
  try {
    const bin = root + "/bin";
    await Deno.mkdir(bin);
    for (const name of ["git", "unzip", "hyperfine"]) {
      await Deno.writeTextFile(
        bin + "/" + name,
        `#!/bin/sh\necho forbidden >> '${root}/forbidden'\nexit 91\n`,
      );
      await Deno.chmod(bin + "/" + name, 0o755);
    }
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        new URL("../../src/cli.ts", import.meta.url).pathname,
        "experiment",
        "capabilities",
        "--quarto",
        nativeQuarto,
      ],
      cwd: root,
      env: { PATH: bin + ":" + Deno.env.get("PATH") },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    assert.equal(JSON.parse(new TextDecoder().decode(out.stdout)).runtime.quarto.version, "1.11.6");
    await assert.rejects(() => Deno.stat(root + "/forbidden"), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
