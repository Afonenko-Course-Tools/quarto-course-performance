import type { SourceManifest } from "../../config/types.ts";
import { delimiter, join, resolve } from "node:path";
import { hashFile } from "../../sources/snapshot.ts";
// Subprocess ищет bare command в PATH; receipts должны читать тот же файл.
async function executablePath(command: string, env: Record<string, string>): Promise<string> {
  if (command.includes("/") || command.includes("\\")) return resolve(command);
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory, command);
    try {
      const info = await Deno.stat(candidate);
      if (info.isFile && (info.mode === null || (info.mode & 0o111) !== 0)) return candidate;
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound) &&
        !(error instanceof Deno.errors.NotADirectory) &&
        !(error instanceof Deno.errors.PermissionDenied)
      ) throw error;
    }
  }
  throw new Error(`Исполняемый файл ${command} не найден в effective PATH`);
}

export async function probeQuarto(
  runtimePath: string,
  overrides: Record<string, string> = {},
) {
  const env = { ...Deno.env.toObject(), ...overrides };
  const run = async (cmd: string, args: string[]) => {
    const out = await new Deno.Command(cmd, {
      args,
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
    return new TextDecoder().decode(out.stdout).trim();
  };
  const [bin, share] = (await run(runtimePath, ["--paths"])).split("\n");
  if (!bin || !share) throw new Error("Неизвестная структура Quarto");
  const deno = await executablePath(
    env.QUARTO_DENO || join(bin, "tools", Deno.build.arch, "deno"),
    env,
  );
  let pandoc = env.QUARTO_PANDOC || join(bin, "tools", Deno.build.arch, "pandoc");
  if (!env.QUARTO_PANDOC) {
    try {
      await Deno.stat(pandoc);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      pandoc = join(bin, "tools/pandoc");
    }
  }
  pandoc = await executablePath(pandoc, env);
  const help = await run(deno, ["run", "--help"]),
    version = await run(runtimePath, ["--version"]),
    main = join(share, "filters/main.lua");
  let source: string | undefined;
  try {
    source = await Deno.readTextFile(main);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const runtime: SourceManifest["runtime"] = {
    quarto: { path: join(bin, "quarto"), version, hash: await hashFile(join(bin, "quarto")) },
    quartoBundle: {
      path: join(bin, "quarto.js"),
      version,
      hash: await hashFile(join(bin, "quarto.js")),
    },
    ...(source === undefined
      ? {}
      : { quartoFilters: { path: main, version, hash: await hashFile(main) } }),
    deno: { path: deno, version: await run(deno, ["--version"]), hash: await hashFile(deno) },
    pandoc: {
      path: pandoc,
      version: await run(pandoc, ["--version"]),
      hash: await hashFile(pandoc),
    },
  };
  return {
    runtimeHash: await hashFile(join(bin, "quarto.js")),
    denoCpu: help.includes("--cpu-prof-dir"),
    denoPreload: help.includes("--preload"),
    luaHook: (await run(pandoc, ["--version"])).includes("Lua 5.4"),
    luaSampling: false,
    filterAdapter: source !== undefined &&
      source.includes("function run_emulated_filter(doc, filter, traverser)") &&
      source.includes("_quarto.ast = {"),
    bin,
    share,
    deno,
    pandoc,
    version,
    runtime,
  };
}
