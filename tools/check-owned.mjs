// Автоматический состав собственных файлов; каждый формат имеет одного владельца.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(dirname(dirname(fileURLToPath(import.meta.url))));
const write = process.argv.slice(2).includes("--write");
if (process.argv.slice(2).some((arg) => arg !== "--write")) throw Error("Неизвестный параметр");
/** @param {string} bin @param {string[]} args */
function run(bin, args) {
  console.log(`$ ${bin} ${args.join(" ")}`);
  execFileSync(bin, args, { stdio: "inherit" });
}
const files = [
  ...new Set(
    execFileSync("git", [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ], { encoding: "utf8" }).split("\0"),
  ),
].filter((file) =>
  file && existsSync(file) && !/(^|\/)(vendor|node_modules|generated|_generated)(\/|$)/.test(file)
).sort();
// Архивные планы, handoff, отчёты выпусков и pilot report хранят исходные цитаты/снимки.
// Это исторические входы; активная документация продолжает форматироваться автоматически.
/** @param {string} file */
const archival = (file) =>
  /^docs\/(?:handoff|releases|superpowers|plan)\//.test(file) ||
  file === "docs/java-pilot-report.md";
const deno = files.filter((file) =>
  /\.(?:ts|js|cjs|mjs|json|jsonc|md)$/.test(file) && !archival(file)
);
const script = files.filter((file) => /\.(?:ts|js|cjs|mjs)$/.test(file));
const lua = files.filter((file) => file.endsWith(".lua") || file === ".luacheckrc");
const python = files.filter((file) => file.endsWith(".py"));
const yaml = files.filter((file) => /\.ya?ml$/.test(file));
const toml = files.filter((file) => file.endsWith(".toml"));
const shell = files.filter((file) =>
  /\.sh$/.test(file) || file.endsWith("/PKGBUILD") ||
  (!/\.[^/]+$/.test(file) && /^#!.*\b(?:ba)?sh\b/.test(readFileSync(file, "utf8")))
);
if (!script.length || !lua.length) throw Error("Пустой собственный состав");
run("deno", ["fmt", ...(write ? [] : ["--check"]), ...deno]);
run("deno", ["lint", ...script]);
run("deno", ["check", ...script.filter((file) => file.endsWith(".ts"))]);
run("node_modules/.bin/tsc", ["--project", "typecheck/helpers.json"]);
run("stylua", [...(write ? [] : ["--check"]), ...lua]);
run("luacheck", ["--no-color", ...lua]);
if (python.length) {
  run("ruff", ["check", ...(write ? ["--fix"] : []), ...python]);
  run("ruff", ["format", ...(write ? [] : ["--check"]), ...python]);
  run("pyright", ["--warnings", "--project", "pyrightconfig.json"]);
}
if (shell.length) {
  run("shfmt", [write ? "-w" : "-d", "-i", "2", "-ci", ...shell]);
  run("shellcheck", ["--external-sources", "--source-path=SCRIPTDIR/..", ...shell]);
}
if (toml.length) {
  run("taplo", ["format", "--no-auto-config", ...(write ? [] : ["--check"]), ...toml]);
}
if (yaml.length) {
  run("prettier", [write ? "--write" : "--check", ...yaml]);
  run("yamllint", ["--strict", ...yaml]);
}
const workflows = yaml.filter((file) => file.startsWith(".github/workflows/"));
if (workflows.length) run("actionlint", [...workflows]);
console.log(
  JSON.stringify({
    deno: deno.length,
    script: script.length,
    lua: lua.length,
    python: python.length,
    shell: shell.length,
    yaml: yaml.length,
    toml: toml.length,
    workflows: workflows.length,
  }),
);
