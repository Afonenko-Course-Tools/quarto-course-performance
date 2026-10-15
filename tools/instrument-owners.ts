// Инструмент подготовки owner PR; не используется установленным курсом.
import ts from "npm:typescript@5.9.3";
import luaparse from "npm:luaparse@0.3.1";
import { basename, dirname, join, relative } from "node:path";
import { files } from "../src/sources/snapshot.ts";
const project = new URL("../", import.meta.url).pathname;
// deno-lint-ignore no-explicit-any
type LuaNode = any;
const registry: unknown[] = [];
// Однократная миграция: повторное выполнение не должно дублировать регистрацию.
for (const root of Deno.args) {
  for (const path of await files(join(root, "_extensions"))) {
    if (
      (path.endsWith(".ts") || path.endsWith(".lua")) && !path.includes("/observability/") &&
      /__metrics|__perfWalk|__perfFilters/.test(await Deno.readTextFile(path))
    ) {
      throw new Error(`Owner уже размечен: ${path}. Используйте sync-bridge для ABI.`);
    }
  }
}
for (const root of Deno.args) {
  const extRoot = join(root, "_extensions");
  for await (const entry of Deno.readDir(extRoot)) {
    if (!entry.isDirectory) continue;
    const ext = join(extRoot, entry.name), id = entry.name;
    const bridgeDir = join(ext, "observability");
    await Deno.mkdir(bridgeDir, { recursive: true });
    for (const kind of ["ts", "lua"]) {
      await Deno.copyFile(
        join(project, "bridge/bridge." + kind),
        join(bridgeDir, "bridge." + kind),
      );
    }
    const sourceFiles = (await files(ext)).filter((p) =>
      !p.includes("/vendor/") && !p.includes("/observability/") && !p.includes("/spec/") &&
      !p.includes("/generated/")
    );
    for (const path of sourceFiles) {
      const rel = relative(ext, path),
        base = rel.replace(/\.(ts|lua)$/, ""),
        source = await Deno.readTextFile(path);
      if (
        path.endsWith(".ts") &&
        (/^(application|infrastructure|body-export|project-checks)\//.test(rel)) &&
        !/vocabulary|diagnostics|contract|domain|schema|config/.test(rel)
      ) {
        const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true),
          wraps: string[] = [];
        for (const node of file.statements) {
          if (
            ts.isFunctionDeclaration(node) && node.name && node.body &&
            node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
          ) {
            // Scalar HTML helpers выполняются для каждого узла; не являются semantic границей.
            if (
              id === "reference-catalog" &&
              (rel === "infrastructure/html.ts" &&
                  !["parseHtml", "replace"].includes(node.name.text) ||
                rel === "infrastructure/search.ts" && node.name.text !== "updateSearch")
            ) continue;
            const name = node.name.text,
              async = node.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
              kind = basename(path) === "process.ts"
                ? "command"
                : rel.startsWith("infrastructure/")
                ? "io"
                : "phase",
              operation = `${id}.${base.replaceAll("/", ".")}.${name}`;
            wraps.push(
              `// @ts-expect-error JS допускает замену function binding; сигнатура публичного API сохраняется.\n${name}=__metrics.wrap${
                async ? "Async" : "Sync"
              }({id:${JSON.stringify(operation)},kind:${JSON.stringify(kind)}},${name});`,
            );
            registry.push({ extension: id, path: rel, operation, kind });
          }
        }
        if (wraps.length) {
          const bridge = relative(dirname(path), join(ext, "observability/bridge.ts"));
          let next =
            `import {createMetrics as __createMetrics} from ${
              JSON.stringify(bridge.startsWith(".") ? bridge : "./" + bridge)
            };\nconst __metrics=__createMetrics(${JSON.stringify(id)});\n` + source + "\n" +
            wraps.join("\n") + "\n";
          if (basename(path) === "process.ts") {
            next = next.replace(/env: (env|extra)([, }])/g, "env: __metrics.childEnv($1)$2");
          }
          await Deno.writeTextFile(path, next);
        }
      }
      if (path.endsWith(".lua")) {
        const ast = luaparse.parse(source, { ranges: true, luaVersion: "5.3" }) as LuaNode,
          edits: { start: number; end: number; text: string }[] = [],
          declarations: string[] = [];
        let number = 0;
        const imports = relative(dirname(path), join(ext, "observability/bridge")).replaceAll(
          "\\",
          "/",
        );
        const header = `local __metrics=require(${
          JSON.stringify(imports.startsWith(".") ? imports : "./" + imports)
        }).create_metrics(${JSON.stringify(id)},1)\n`;
        function visit(node: LuaNode) {
          if (!node || typeof node !== "object") return;
          if (
            node.type === "CallExpression" && node.base?.type === "MemberExpression" &&
            node.base.indexer === ":" && node.base.identifier.name === "walk"
          ) {
            const receiver = source.slice(...node.base.base.range as [number, number]),
              n = ++number,
              varName = `__perfWalk${n}`,
              scope = /^pandoc\.Pandoc\(/.test(receiver)
                ? "fragment"
                : /^(doc|document|public|raw)$/.test(receiver)
                ? "full-document"
                : /^(div|el|block)$/.test(receiver)
                ? "block"
                : /^(span|inline|inlines)$/.test(receiver)
                ? "inline"
                : "unknown",
              operation = `${id}.${base.replaceAll("/", ".")}.walk.${n}`;
            declarations.push(
              `local ${varName}=__metrics.wrap_walk({id=${
                JSON.stringify(operation)
              },kind='ast_walk',scope=${
                JSON.stringify(scope)
              }},function(node,filter)return node:walk(filter)end)`,
            );
            edits.push({ start: node.base.range[0], end: node.base.range[1], text: varName });
            const offset = source.indexOf("(", node.base.range[1]) + 1;
            edits.push({
              start: offset,
              end: offset,
              text: receiver + (node.arguments.length ? "," : ""),
            });
            registry.push({ extension: id, path: rel, operation, kind: "ast_walk", scope });
          }
          for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
              for (const child of value) visit(child);
            } else if (value && typeof value === "object") {
              visit(value);
            }
          }
        }
        visit(ast);
        const topReturn = ast.body.findLast((x: LuaNode) => x.type === "ReturnStatement"),
          wraps: string[] = [];
        for (const node of ast.body) {
          if (
            node.type === "FunctionDeclaration" && node.identifier?.type === "MemberExpression" &&
            node.identifier.base.name === "M"
          ) {
            const name = node.identifier.identifier.name,
              operation = `${id}.${base.replaceAll("/", ".")}.${name}`;
            wraps.push(
              `M.${name}=__metrics.wrap_sync({id=${
                JSON.stringify(operation)
              },kind='phase'},M.${name})`,
            );
            registry.push({ extension: id, path: rel, operation, kind: "phase" });
          }
        }
        let filterHelper = "";
        if (topReturn?.arguments[0]?.type === "TableConstructorExpression") {
          const arg = topReturn.arguments[0];
          edits.push({ start: arg.range[0], end: arg.range[0], text: "__perfFilters(" }, {
            start: arg.range[1],
            end: arg.range[1],
            text: ")",
          });
          filterHelper =
            `local function __perfFilters(filters)\n for key,value in pairs(filters) do\n  if type(value)=='function' then filters[key]=__metrics.wrap_sync({id=${
              JSON.stringify(id + "." + base.replaceAll("/", ".") + ".handler.")
            }..tostring(key),kind=key=='Pandoc' and 'phase' or 'function'},value)\n  elseif type(value)=='table' and type(key)=='number' then filters[key]=__perfFilters(value) end\n end\n return filters\nend\n`;
          registry.push({
            extension: id,
            path: rel,
            operation: id + "." + base.replaceAll("/", ".") + ".handler.*",
            kind: "phase",
          });
        }
        if (wraps.length && topReturn) {
          edits.push({
            start: topReturn.range[0],
            end: topReturn.range[0],
            text: wraps.join("\n") + "\n",
          });
        }
        if (edits.length) {
          let result = source;
          for (const edit of edits.sort((a, b) => b.start - a.start)) {
            result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
          }
          await Deno.writeTextFile(
            path,
            header + declarations.join("\n") + "\n" + filterHelper + result,
          );
        }
      }
    }
  }
}
await Deno.writeTextFile(
  join(project, "docs/operation-registry.json"),
  JSON.stringify(registry, null, 2) + "\n",
);
