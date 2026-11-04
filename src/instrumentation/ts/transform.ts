import ts from "npm:typescript@5.9.3";
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
  scope: { strict: boolean; bridgeUrl?: string; topLevelFunctions?: readonly string[] },
): InstrumentedModule {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    symbols: SymbolReceipt[] = [],
    skipped: { position: number; reason: string }[] = [],
    insertions: { pos: number; text: string }[] = [];
  if (
    (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length
  ) throw new Error("Ошибка разбора TypeScript");
  // Явный partial scope не добавляет wrappers во вложенные функции.
  const functions = scope.topLevelFunctions;
  const selected = functions === undefined ? undefined : new Set<ts.FunctionDeclaration>();
  if (functions !== undefined && selected) {
    const names = new Set(functions);
    if (names.size !== functions.length) {
      throw new Error("Неполное coverage: повтор выбранного имени функции");
    }
    for (const name of names) {
      const matches = file.statements.filter((node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name
      );
      if (matches.length !== 1 || !matches[0].body) {
        throw new Error(`Неполное coverage: нет единственной функции с body: ${name}`);
      }
      selected.add(matches[0]);
    }
  }
  const manuallyWrapped = new Set<string>();
  function findManual(node: ts.Node, active = selected === undefined) {
    const observed = active || ts.isFunctionDeclaration(node) && !!selected?.has(node);
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
      } else if (observed) {
        skipped.push({
          position: node.getStart(file),
          reason: "Local/aliased manual rebind не поддержан",
        });
      }
    }
    if (
      observed && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      /^wrap(Sync|Async|Walk)$/.test(node.expression.name.text) &&
      node.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))
    ) {
      skipped.push({
        position: node.getStart(file),
        reason: "Inline manual callback не поддержан",
      });
    }
    ts.forEachChild(node, (child) => findManual(child, observed));
  }
  findManual(file);
  function walk(node: ts.Node) {
    if (selected) {
      if (node === file) {
        for (const declaration of selected) walk(declaration);
        return;
      }
      if (!ts.isFunctionDeclaration(node) || !selected.has(node)) return;
    }
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
  if ((scope.strict || selected !== undefined) && skipped.length) {
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
