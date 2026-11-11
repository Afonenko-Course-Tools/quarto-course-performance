import { delimiter, join, resolve } from "node:path";
import type { SourceManifest } from "../../config/types.ts";
import { isObject, parseJson } from "../../json.ts";
// Subprocess ищет bare command в PATH; receipts должны читать тот же файл.
export async function executablePath(
  command: string,
  env: Record<string, string>,
): Promise<string> {
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

export type CpuProbe =
  | { status: "available" }
  | { status: "unsupported" | "error"; reason: string };

/** Help скрывает часть поддержанных флагов: проверяется настоящий V8 artifact. */
export async function probeDenoCpu(
  executable: string,
  env: Record<string, string>,
  timeoutMilliseconds = 2000,
): Promise<CpuProbe> {
  const directory = await Deno.makeTempDir({ prefix: "course-perf-cpu-probe-" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const source = join(directory, "probe.js");
    await Deno.writeTextFile(source, "for(let i=0;i<100000;i++) Math.sqrt(i);\n");
    const child = new Deno.Command(executable, {
      args: [
        "run",
        "--no-config",
        "--no-lock",
        "--cpu-prof-dir",
        directory,
        "--cpu-prof-name",
        "probe.cpuprofile",
        source,
      ],
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }, timeoutMilliseconds);
    const output = await child.output();
    if (timedOut) return { status: "error", reason: "CPU probe превысил время ожидания" };
    if (!output.success) {
      const reason = new TextDecoder().decode(output.stderr).trim() ||
        `CPU probe: exit ${output.code}`;
      return {
        status: /(?:unexpected|unrecognized|unknown|unsupported).*cpu-prof/is.test(reason)
          ? "unsupported"
          : "error",
        reason,
      };
    }
    const profile = parseJson(await Deno.readTextFile(join(directory, "probe.cpuprofile")));
    if (
      !isObject(profile) || !Array.isArray(profile.nodes) || profile.nodes.length === 0 ||
      !Array.isArray(profile.samples) || !Number.isFinite(profile.startTime) ||
      !Number.isFinite(profile.endTime)
    ) {
      return { status: "error", reason: "CPU probe не создал корректный V8 profile" };
    }
    return { status: "available" };
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    await Deno.remove(directory, { recursive: true });
  }
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
    quarto: { path: join(bin, "quarto"), version },
    quartoBundle: {
      path: join(bin, "quarto.js"),
      version,
    },
    ...(source === undefined ? {} : { quartoFilters: { path: main, version } }),
    deno: { path: deno, version: await run(deno, ["--version"]) },
    pandoc: {
      path: pandoc,
      version: await run(pandoc, ["--version"]),
    },
  };
  const denoCpuProbe = await probeDenoCpu(deno, env);
  return {
    denoCpu: denoCpuProbe.status === "available",
    denoCpuProbe,
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
