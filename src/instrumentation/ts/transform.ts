import type * as TS from "typescript";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Типы и runtime используют системную поставку; путь можно переназначить для другой ОС.
const compilerPath = Deno.env.get("COURSE_PERF_TYPESCRIPT") ||
  fileURLToPath(import.meta.resolve("typescript")).replace(/\.d\.ts$/, ".js");
const ts: typeof TS = createRequire(import.meta.url)(compilerPath);
export interface SymbolReceipt {
  id: string;
  path: string;
  start: number;
  end: number;
  manuallyWrapped: boolean;
}
export interface InstrumentedModule {
  source: string;
  symbols: SymbolReceipt[];
  skipped: { position: number; reason: string }[];
}
export function instrumentModule(
  source: string,
  path: string,
  scope: { strict: boolean; bridgeUrl?: string },
): InstrumentedModule {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    symbols: SymbolReceipt[] = [],
    skipped: { position: number; reason: string }[] = [],
    insertions: { pos: number; text: string }[] = [];
  const options: TS.CompilerOptions = { noLib: true, noResolve: true, types: [] };
  const host: TS.CompilerHost = {
    ...ts.createCompilerHost(options),
    getSourceFile: () => file,
  };
  const program = ts.createProgram([path], options, host);
  if (program.getSyntacticDiagnostics(file).length) {
    throw new Error("Ошибка разбора TypeScript");
  }
  const manuallyWrapped = new Set<string>();
  function findManual(node: TS.Node) {
    if (
      ts.isBinaryExpression(node) && ts.isIdentifier(node.left) &&
      ts.isCallExpression(node.right) && ts.isPropertyAccessExpression(node.right.expression) &&
      /^wrap(Sync|Async|Walk)$/.test(node.right.expression.name.text)
    ) {
      const name = node.left.text;
      if (
        ts.isExpressionStatement(node.parent) && node.parent.parent === file &&
        file.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === name && s.body)
      ) {
        manuallyWrapped.add(name);
      } else {skipped.push({
          position: node.getStart(file),
          reason: "Local/aliased manual rebind не поддержан",
        });}
    }
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      /^wrap(Sync|Async|Walk)$/.test(node.expression.name.text) &&
      node.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))
    ) {
      skipped.push({
        position: node.getStart(file),
        reason: "Inline manual callback не поддержан",
      });
    }
    ts.forEachChild(node, findManual);
  }
  findManual(file);
  function walk(node: TS.Node) {
    if (
      ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      skipped.push({
        position: node.getStart(file),
        reason: "Конструктор или accessor не поддержан",
      });
    } else if (
      ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      if (!node.body) return;
      if (node.asteriskToken || node.modifiers?.some((m) => m.kind === ts.SyntaxKind.Decorator)) {
        skipped.push({
          position: node.getStart(file),
          reason: "Generator или decorator не поддержан",
        });
      } else if (/\beval\s*\(/.test(node.body.getText(file))) {
        skipped.push({ position: node.getStart(file), reason: "Direct eval изменяет scope" });
      } else {
        const start = node.getStart(file), end = node.end, id = `${path}:${start}:${end}`;
        const name = node.name?.getText(file),
          manual = ts.isFunctionDeclaration(node) && node.parent === file && !!name &&
            manuallyWrapped.has(name);
        symbols.push({ id, path, start, end, manuallyWrapped: manual });
        if (!manual) {
          const async = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
            call = `__coursePerf.wrap${async ? "Async" : "Sync"}(${
              JSON.stringify({ id, kind: "function", origin: "auto", symbol_id: id })
            }, ${async ? "async " : ""}() => `;
          if (ts.isBlock(node.body)) {
            insertions.push({ pos: node.body.getStart(file) + 1, text: `return ${call}{` }, {
              pos: node.body.end - 1,
              text: "})();",
            });
          } else {insertions.push({ pos: node.body.getStart(file), text: `${call}(` }, {
              pos: node.body.end,
              text: "))()",
            });}
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(file);
  if (scope.strict && skipped.length) {
    throw new Error(`Неполное coverage: ${JSON.stringify(skipped)}`);
  }
  let result = source;
  for (const edit of insertions.sort((a, b) => b.pos - a.pos)) {
    result = result.slice(0, edit.pos) + edit.text + result.slice(edit.pos);
  }
  if (insertions.length) {
    const offset = result.startsWith("#!") ? result.indexOf("\n") + 1 : 0;
    result = result.slice(0, offset) +
      `import {createMetrics as __createCoursePerf} from ${
        JSON.stringify(scope.bridgeUrl ?? "../../observability/bridge.ts")
      };\nconst __coursePerf=__createCoursePerf('auto');\n` + result.slice(offset);
  }
  return { source: result, symbols, skipped };
}
