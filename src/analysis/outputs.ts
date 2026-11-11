import { relative } from "node:path";
import type { OutputPolicy } from "../config/types.ts";
import { string } from "../json.ts";
import { files } from "../sources/files.ts";

// Исторические атрибуты упражнений Core: значения и остальные bytes сохраняются.
// Нормализация QRC предоставляется владельцем через explicit normalizeHtml adapter.
export function normalizeOutput(
  path: string,
  contents: string,
  policy: OutputPolicy = "strict",
): string {
  if (policy === "strict" || !path.endsWith(".html")) return contents;
  return contents.replace(
    /<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<(?:a|div)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi,
    (chunk) => {
      const prefix = chunk.match(/^<(a|div)\b/i);
      if (!prefix) return chunk;
      const start = prefix[0].length;
      const body = chunk.slice(start, -1);
      const attrs = [...body.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g)];
      // Не переписывать malformed HTML и duplicate attrs (их первый value значим).
      if (body.replace(/([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g, "").trim()) {
        return chunk;
      }
      const names = attrs.map((a) => string(a[1]).toLowerCase());
      if (new Set(names).size !== names.length) return chunk;
      const value = (name: string) => {
        const attr = attrs.find((a) => string(a[1]).toLowerCase() === name);
        return attr?.[0].match(/=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))$/)?.slice(1).find((v) =>
          v !== undefined
        );
      };

      const allowed =
        (value("id") ?? "").startsWith("exr-") && string(prefix[1]).toLowerCase() === "div"
          ? [
            "target",
            "data-statement-visibility",
            "data-course-difficulty",
            "data-course-time",
            "data-course-role",
          ]
          : [];
      const selected = attrs.filter((a) => allowed.includes(string(a[1]).toLowerCase()));
      const ordered = [...selected].sort((a, b) => string(a[1]).localeCompare(string(b[1])));
      let result = chunk.slice(0, start), cursor = 0, index = 0;
      for (const attr of selected) {
        const next = ordered[index++];
        if (!next) throw new Error("Неполная перестановка HTML-атрибутов");
        const text = next[0];
        result += body.slice(cursor, attr.index) + text;
        cursor = attr.index! + attr[0].length;
      }
      return result + body.slice(cursor) + ">";
    },
  );
}
export async function compareOutputs(
  left: string,
  right: string,
  roots: {
    outputPolicy?: OutputPolicy;
    leftSourceRoot?: string;
    rightSourceRoot?: string;
    normalizeHtml?: (contents: string, sourceRoot?: string) => string;
  } = {},
) {
  const a = new Map((await files(left)).map((p) => [relative(left, p), p])),
    b = new Map((await files(right)).map((p) => [relative(right, p), p]));
  const differences: string[] = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(name) || !b.has(name)) {
      differences.push(`${name}: отсутствует в одном варианте`);
      continue;
    }
    if (name.endsWith(".zip") && roots.outputPolicy === "java-pilot-core-qrc-v1") {
      const list = async (path: string) => {
        const out = await new Deno.Command("unzip", {
          args: ["-Z1", path],
          stdout: "piped",
          stderr: "piped",
        }).output();
        if (!out.success) throw new Error("Невалидный ZIP");
        return new TextDecoder().decode(out.stdout).trim().split("\n").sort();
      };
      const names = await list(a.get(name)!), other = await list(b.get(name)!);
      if (JSON.stringify(names) !== JSON.stringify(other)) {
        differences.push(`${name}: ZIP entries различаются`);
        continue;
      }
      for (const entry of names) {
        const extract = async (path: string) =>
          await new Deno.Command("unzip", {
            args: ["-p", path, entry],
            stdout: "piped",
            stderr: "piped",
          }).output();
        const [x, y] = await Promise.all([extract(a.get(name)!), extract(b.get(name)!)]);
        if (
          !x.success || !y.success || x.stdout.length !== y.stdout.length ||
          x.stdout.some((v, i) => v !== y.stdout[i])
        ) differences.push(`${name}/${entry}: ZIP bytes различаются`);
      }
    } else if (!equalBytes(await Deno.readFile(a.get(name)!), await Deno.readFile(b.get(name)!))) {
      if (
        roots.outputPolicy !== "java-pilot-core-qrc-v1" || !name.endsWith(".html") ||
        normalizeOutput(
            name,
            roots.outputPolicy === "java-pilot-core-qrc-v1" && roots.normalizeHtml
              ? roots.normalizeHtml(await Deno.readTextFile(a.get(name)!), roots.leftSourceRoot)
              : await Deno.readTextFile(a.get(name)!),
            roots.outputPolicy,
          ) !==
          normalizeOutput(
            name,
            roots.outputPolicy === "java-pilot-core-qrc-v1" && roots.normalizeHtml
              ? roots.normalizeHtml(await Deno.readTextFile(b.get(name)!), roots.rightSourceRoot)
              : await Deno.readTextFile(b.get(name)!),
            roots.outputPolicy,
          )
      ) differences.push(`${name}: bytes различаются`);
    }
  }
  return { equivalent: !differences.length, differences };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
