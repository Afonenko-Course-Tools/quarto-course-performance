import { join, relative } from "node:path";
import { files, hashFile } from "../sources/snapshot.ts";
function orderedDistinct(group: string, attrs: string[]): string {
  if (new Set(attrs.map((a) => a.slice(0, a.indexOf("=")))).size !== attrs.length) return group;
  return attrs.sort().join(" ") + (group.endsWith(" ") ? " " : "");
}
// Allowlist 1: Pandoc меняет порядок этих трёх QRC атрибутов между независимыми runs.
export function normalizeOutput(path: string, contents: string): string {
  if (!path.endsWith(".html")) return contents;
  return contents.replace(
    /<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<(?:a|div)\b[^>]*>/gi,
    (chunk) => {
      if (/^<div\b/i.test(chunk) && /\bid="exr-[^"]*"/.test(chunk)) {
        return chunk.replace(
          /(?:target="[^"]*"\s*|data-statement-visibility="[^"]*"\s*){2}/g,
          (group) =>
            orderedDistinct(
              group,
              [...group.matchAll(/(?:target|data-statement-visibility)="[^"]*"/g)].map((m) => m[0]),
            ),
        );
      }
      if (!/^<a\b/i.test(chunk)) return chunk;
      return chunk.replace(/(?:data-qrc-(?:ref|custom|style)="[^"]*"\s*){2,}/g, (group) => {
        const attrs = [...group.matchAll(/data-qrc-(?:ref|custom|style)="[^"]*"/g)].map((m) =>
          m[0]
        );
        return orderedDistinct(group, attrs);
      });
    },
  );
}
export async function compareOutputs(left: string, right: string) {
  const a = new Map((await files(left)).map((p) => [relative(left, p), p])),
    b = new Map((await files(right)).map((p) => [relative(right, p), p]));
  const differences: string[] = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(name) || !b.has(name)) {
      differences.push(`${name}: отсутствует в одном варианте`);
      continue;
    }
    if (name.endsWith(".zip")) {
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
    } else if (await hashFile(a.get(name)!) !== await hashFile(b.get(name)!)) {
      if (
        !name.endsWith(".html") ||
        normalizeOutput(name, await Deno.readTextFile(a.get(name)!)) !==
          normalizeOutput(name, await Deno.readTextFile(b.get(name)!))
      ) differences.push(`${name}: bytes различаются`);
    }
  }
  return { equivalent: !differences.length, differences };
}
