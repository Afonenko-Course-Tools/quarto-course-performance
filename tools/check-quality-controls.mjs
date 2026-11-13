// Проверяет правила штатной командой на новых production-файлах; исходники всегда удаляются.
import { execFileSync } from "node:child_process";
import process from "node:process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scope } from "../eslint.config.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
/** @type {string[]} */
const files = [];
const productionPrefix = scope[0];
if (!productionPrefix) throw Error("Пустой production scope");
function run() {
  try {
    return {
      status: 0,
      output: execFileSync(
        process.execPath,
        ["tools/check-quality.mjs", ...process.argv.slice(2)],
        { cwd: root, encoding: "utf8", stdio: "pipe", maxBuffer: 32 * 1024 * 1024 },
      ),
    };
  } catch (error) {
    return {
      status: error instanceof Error && "status" in error && typeof error.status === "number"
        ? error.status
        : 1,
      output: String(error instanceof Error && "stdout" in error ? error.stdout : "") +
        String(error instanceof Error && "stderr" in error ? error.stderr : ""),
    };
  }
}
/** @param {string} path @param {string} source */
function put(path, source) {
  const file = join(root, path);
  if (existsSync(file)) throw Error("Контрольный путь уже занят: " + file);
  writeFileSync(file, source);
  files.push(file);
}
function clean() {
  for (const file of files.splice(0)) unlinkSync(file);
}
/** @param {string} output */
function parseReceipt(output) {
  /** @type {unknown} */
  const value = JSON.parse(output.trim().split("\n").at(-1) ?? "");
  if (
    !value || typeof value !== "object" ||
    !("javascriptChecked" in value) || typeof value.javascriptChecked !== "number" ||
    !("structuralChecked" in value) || typeof value.structuralChecked !== "number"
  ) {
    throw Error("Неверный quality receipt");
  }
  return { javascriptChecked: value.javascriptChecked, structuralChecked: value.structuralChecked };
}
/** @type {Array<[string, string]>} */
const cases = [
  ["no-explicit-any", "export const explicit: any = 1;"],
  ["ban-ts-comment", "// @ts-ignore\nexport const ignored = 1;"],
  ["no-unsafe-type-assertion", "export const narrowed = ({} as unknown) as string;"],
  ["no-unsafe-assignment", `export const assigned: string = JSON.parse('{}');`],
  [
    "no-unsafe-argument",
    `function consume(value: string): string { return value; } export const argument = consume(JSON.parse('{}'));`,
  ],
  ["no-unsafe-call", `export const called: unknown = JSON.parse('{}')();`],
  ["no-unsafe-member-access", `export const member: unknown = JSON.parse('{}').field;`],
  ["no-unsafe-return", `export function returned(): string { return JSON.parse('{}'); }`],
  [
    "switch-exhaustiveness-check",
    `export function omitted(value: 'a'|'b'): number | undefined { switch(value) { case 'a': return 1; } return undefined; }`,
  ],
  [
    "complexity",
    "export function complex(value: number): number { " +
    Array.from({ length: 31 }, (_, n) => `if(value === ${n}) return ${n};`).join(" ") +
    " return -1; }",
  ],
  [
    "max-depth",
    "export function deep(value: boolean): number { " + "if(value) { ".repeat(6) + "return 1;" +
    " }".repeat(6) + " return 0; }",
  ],
  [
    "max-params",
    "export function parameters(a: number,b: number,c: number,d: number,e: number,f: number): number { return a+b+c+d+e+f; }",
  ],
  ["noInlineConfig", "// eslint-disable-next-line complexity\nexport const disabled = 1;"],
  ["malformed AST", "export const malformed = ;"],
];
try {
  const positive = run();
  if (positive.status !== 0) {
    throw Error("Исходный production gate не проходит:\n" + positive.output);
  }
  console.log(JSON.stringify({ control: "positive", status: "passed" }));
  const baseline = parseReceipt(positive.output);
  for (
    const [name, source, expected] of [
      ["strict-helper-checkJs", '/** @type {number} */ export const typed = "wrong";', "TS2322"],
      [
        "typed-helper-no-unsafe-assignment",
        '/** @type {string} */ export const unsafe = JSON.parse("{}");',
        "no-unsafe-assignment",
      ],
    ]
  ) {
    if (!name || !source || !expected) throw Error("Неверный helper control");
    put("tools/__quality_helper_negative.mjs", source);
    const result = run();
    clean();
    if (result.status === 0 || !result.output.includes(expected)) {
      throw Error("Helper control не обнаружен: " + name + "\n" + result.output);
    }
    console.log(JSON.stringify({ control: name, status: "rejected" }));
  }

  for (
    const [path, source] of [
      [
        "tools/__quality_helper_negative.cjs",
        '/** @type {number} */ const typed = "wrong"; module.exports = typed;',
      ],
      ["__quality_helper_negative.js", '/** @type {number} */ export const typed = "wrong";'],
    ]
  ) {
    if (!path || !source) throw Error("Неверный helper extension control");
    put(path, source);
    const result = run();
    clean();
    if (result.status === 0 || !result.output.includes("TS2322")) {
      throw Error("Новый Node helper не проверен: " + path + "\n" + result.output);
    }
    console.log(JSON.stringify({ control: path, status: "rejected" }));
  }
  for (const extension of ["js", "cjs", "mjs"]) {
    put(
      productionPrefix + "__quality_positive." + extension,
      extension === "cjs"
        ? "exports.currentDirectory = Deno.cwd();"
        : "export const currentDirectory = Deno.cwd();",
    );
    const javascriptPositive = run();
    clean();
    if (javascriptPositive.status !== 0) {
      throw Error("Настоящий Deno JS context не прошёл:\n" + javascriptPositive.output);
    }
    const receipt = parseReceipt(javascriptPositive.output);
    if (
      receipt.javascriptChecked !== baseline.javascriptChecked + 1 ||
      receipt.structuralChecked !== baseline.structuralChecked + 1
    ) {
      throw Error("Неполный typed/structural учёт production " + extension);
    }
    console.log(
      JSON.stringify({ control: "real-deno-context-and-count-" + extension, status: "passed" }),
    );
    put(
      productionPrefix + "__quality_negative." + extension,
      extension === "cjs"
        ? "/** @type {string} */ exports.unsafeJavaScript = JSON.parse('{}');"
        : "/** @type {string} */ export const unsafeJavaScript = JSON.parse('{}');",
    );
    const javascript = run();
    clean();
    if (javascript.status === 0 || !javascript.output.includes("no-unsafe-assignment")) {
      throw Error(
        "Новый production " + extension + " не проверен typed gate:\n" + javascript.output,
      );
    }
    console.log(JSON.stringify({ control: "automatic-scope-" + extension, status: "rejected" }));
  }
  for (const [rule, source] of cases) {
    put(productionPrefix + "__quality_negative.ts", source);
    const result = run();
    clean();
    const expected = rule === "malformed AST"
      ? /[Ss]yntax|[Pp]ars|TS1109|[Ee]xpression expected/
      : new RegExp(rule);
    if (result.status === 0 || !expected.test(result.output)) {
      throw Error("Контроль не обнаружен: " + rule + "\n" + result.output);
    }
    console.log(JSON.stringify({ control: rule, status: "rejected" }));
  }
  put(
    productionPrefix + "__quality_cycle_a.ts",
    "import { b } from './__quality_cycle_b.ts'; export function a(): number { return b(); }",
  );
  put(
    productionPrefix + "__quality_cycle_b.ts",
    "import { a } from './__quality_cycle_a.ts'; export function b(): number { return a(); }",
  );
  const cycle = run();
  clean();
  if (cycle.status === 0 || !cycle.output.includes("no-production-cycles")) {
    throw Error("Cycle не обнаружен:\n" + cycle.output);
  }
  console.log(JSON.stringify({ control: "no-production-cycles", status: "rejected" }));
  put(
    "src/protocol/__quality_boundary.ts",
    "import * as internal from '../analysis/normalize.ts'; export const boundary = internal;",
  );
  const boundary = run();
  clean();
  if (boundary.status === 0 || !boundary.output.includes("protocol-is-a-leaf")) {
    throw Error("Internal import не обнаружен:\n" + boundary.output);
  }
  console.log(JSON.stringify({ control: "protocol-is-a-leaf", status: "rejected" }));
} finally {
  clean();
}
