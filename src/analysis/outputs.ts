import { relative } from "node:path";
import type { OutputPolicy } from "../config/types.ts";
import { files, hashFile } from "../sources/snapshot.ts";

export async function compareOutputs(
  left: string,
  right: string,
  roots: {
    outputPolicy?: OutputPolicy;
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
    // Java policy проверяет наличие HTML, но не читает и не сравнивает его bytes.
    if (name.endsWith(".html") && roots.outputPolicy === "java-pilot-core-qrc-v1") continue;
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
    } else if (await hashFile(a.get(name)!) !== await hashFile(b.get(name)!)) {
      differences.push(`${name}: bytes различаются`);
    }
  }
  const checkedContentEqual = !differences.length;
  const htmlBytesCompared = roots.outputPolicy !== "java-pilot-core-qrc-v1";
  return {
    checkedContentEqual,
    htmlBytesCompared,
    differences,
    ...(htmlBytesCompared ? { equivalent: checkedContentEqual } : {}),
  };
}
