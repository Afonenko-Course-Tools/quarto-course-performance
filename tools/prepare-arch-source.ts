import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "../src/sources/snapshot.ts";

/** Точный Git-архив и самостоятельный рецепт с вычисленной контрольной суммой. */
export async function prepareArchSource(commit: string, output: string) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Нужен полный commit SHA");
  if (!isAbsolute(output)) throw new Error("--output требует абсолютный новый каталог");
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const git = async (args: string[]) => {
    const result = await new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" })
      .output();
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    return result.stdout;
  };
  const config = JSON.parse(new TextDecoder().decode(await git(["show", `${commit}:deno.json`])));
  if (!/^\d+\.\d+\.\d+$/.test(config.version)) throw new Error("Некорректная версия");
  await Deno.mkdir(output); // Никогда не заменяет существующую сборку.
  const archive = join(output, `quarto-course-perf-${config.version}.tar.gz`);
  await git([
    "archive",
    "--format=tar.gz",
    `--prefix=quarto-course-perf-${commit}/`,
    `--output=${archive}`,
    commit,
  ]);
  const sha256 = await hashFile(archive);
  const recipe = new TextDecoder().decode(await git(["show", `${commit}:packaging/arch/PKGBUILD`]))
    .replaceAll("@SOURCE_COMMIT@", commit).replaceAll("@SOURCE_SHA256@", sha256);
  await Deno.writeTextFile(join(output, "PKGBUILD"), recipe);
  const receipt = {
    commit,
    version: config.version,
    archive,
    sha256,
    createdUTC: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    join(output, "source-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
  return receipt;
}
if (import.meta.main) {
  if (Deno.args.length !== 4 || Deno.args[0] !== "--commit" || Deno.args[2] !== "--output") {
    throw new Error("prepare-arch-source.ts --commit <полный SHA> --output /новый/каталог");
  }
  await prepareArchSource(Deno.args[1], resolve(Deno.args[3]));
}
