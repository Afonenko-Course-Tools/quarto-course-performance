import { strict as assert } from "node:assert";
import { validateConfig } from "../../src/config/validate.ts";
Deno.test("config rejects unknown modes, escaped cwd, duplicate scenarios and missing explicit ref", () => {
  const s = {
    id: "one",
    project: "Java",
    cwd: ".",
    executable: "quarto",
    args: ["render", "--profile", "student"],
    courseProfile: "student",
    cachePolicy: "clean-output",
    mode: "off",
    scope: { modules: [], extensions: [], strict: true },
    resources: { wall: true, cpu: true, peakRss: true },
  };
  const cfg = {
    sources: [{ repository: "org/Java", refPolicy: "remote-default-head" }],
    scenarios: [s],
  };
  assert.equal(validateConfig(cfg).scenarios[0].id, "one");
  for (
    const bad of [
      { ...cfg, scenarios: [{ ...s, mode: "invalid" }] },
      { ...cfg, scenarios: [{ ...s, cwd: "../escape" }] },
      { ...cfg, scenarios: [s, s] },
      { ...cfg, sources: [{ repository: "org/Java", refPolicy: "explicit-remote-ref" }] },
    ]
  ) assert.throws(() => validateConfig(bad));
});
