// Проверяем автоматический выбор новых файлов штатной блокирующей командой.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
function run(env = process.env) {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, ["tools/check-owned.mjs"], {
        cwd: root,
        env,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      }),
    };
  } catch (error) {
    const status = error instanceof Error && "status" in error && typeof error.status === "number"
      ? error.status
      : 1;
    const stdout = error instanceof Error && "stdout" in error ? error.stdout : "";
    const stderr = error instanceof Error && "stderr" in error ? error.stderr : "";
    return { status, output: String(stdout) + String(stderr) };
  }
}
const positive = run();
if (positive.status !== 0) throw Error(positive.output);
/** @type {Array<[string, string, RegExp]>} */
const cases = [
  ["tools/__quality_unformatted.toml", "key=1\n", /not properly formatted|not formatted/],
  ["tools/__quality_malformed.toml", "broken = [\n", /syntax errors|expected/],
  ["tools/__quality_type_negative.py", 'typed: int = "wrong"\n', /reportAssignmentType/],
  [
    "tools/check-owned-negative.mjs",
    '/** @type {number} */\nexport const helperTypeError = "wrong";\n',
    /TS2322/,
  ],
  ["tools/__quality_negative.mjs", "export const unformatted=1;\n", /not formatted/],
  ["tools/__quality_negative.lua", "return unknown_quality_global\n", /undefined variable/],
  ["tools/__quality_negative.py", "print(unknown_quality_global)\n", /F821/],
  ["tools/__quality_negative.sh", "#!/bin/sh\nprintf '%s' $unknown_quality_global\n", /SC2086/],
  [
    "tools/__quality_negative.yml",
    "key: one\nkey: two\n",
    /duplicated mapping key|duplication of key|Map keys must be unique/,
  ],
  [
    ".github/workflows/__quality_negative.yml",
    "name: control\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo valid\n        invalid-quality-key: true\n",
    /unexpected key/,
  ],
];
for (const [relative, source, expected] of cases) {
  const path = join(root, relative);
  if (existsSync(path)) throw Error("Контрольный путь занят: " + path);
  try {
    writeFileSync(path, source);
    const result = run();
    if (result.status === 0 || !expected.test(result.output)) {
      throw Error("Не обнаружен " + relative + "\n" + result.output);
    }
    console.log(JSON.stringify({ control: relative, status: "rejected" }));
  } finally {
    unlinkSync(path);
  }
}

// Только отрицательный контроль: штатный gate обязан сохранить ошибку внешнего CLI.
const temporary = mkdtempSync(join(tmpdir(), "performance-failed-tool-"));
try {
  const failed = join(temporary, "stylua");
  const marker = "PERFORMANCE_TOOL_FAILURE_CONTROL";
  writeFileSync(failed, "#!/bin/sh\nprintf '%s\\n' '" + marker + "'\nexit 37\n");
  chmodSync(failed, 0o755);
  const result = run({ ...process.env, PATH: temporary + delimiter + (process.env.PATH ?? "") });
  if (
    result.status === 0 || !result.output.includes(marker) || result.output.includes('"workflows":')
  ) {
    throw Error("Частичный вывод сбойного CLI получил PASS\n" + result.output);
  }
  console.log(JSON.stringify({ control: "failed-external-stylua-exit-37", status: "rejected" }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
