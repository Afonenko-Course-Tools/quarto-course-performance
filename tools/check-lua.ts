import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ownRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const options = {
  root: ownRoot,
  scopes: [] as string[],
  excludes: [] as string[],
  libraries: [] as string[],
  runtimePaths: ["?.lua", "?/init.lua"],
  server: "lua-language-server",
  probe: false,
};
function absolute(value: string, flag: string): string {
  if (!isAbsolute(value)) throw new Error(`${flag}: требуется абсолютный путь`);
  return resolve(value);
}
function localPath(value: string, flag: string): string {
  if (
    isAbsolute(value) ||
    value.split(/[\\/]/).some((part) => !part || part === "." || part === "..") ||
    /[*?\[\]{}]/.test(value)
  ) {
    throw new Error(`${flag}: требуется явный относительный путь без .. и шаблонов`);
  }
  return value;
}
for (let index = 0; index < Deno.args.length; index++) {
  const flag = Deno.args[index];
  if (flag === "--probe") {
    options.probe = true;
    continue;
  }
  const value = Deno.args[++index];
  if (!value) throw new Error(`${flag}: отсутствует значение`);
  switch (flag) {
    case "--root":
      options.root = absolute(value, flag);
      break;
    case "--scope":
      options.scopes.push(localPath(value, flag));
      break;
    case "--exclude":
      options.excludes.push(localPath(value, flag));
      break;
    case "--library":
      options.libraries.push(absolute(value, flag));
      break;
    case "--runtime-path":
      localPath(value.replaceAll("?", "module"), flag);
      if (!value.includes("?") || /[\\;]/.test(value)) {
        throw new Error(`${flag}: разрешён только относительный шаблон с ?`);
      }
      options.runtimePaths.push(value);
      break;
    case "--server":
      options.server = absolute(value, flag);
      break;
    default:
      throw new Error(`Неизвестный параметр: ${flag}`);
  }
}
if (options.root !== ownRoot && options.scopes.length === 0) {
  throw new Error("Для чужого --root требуется явный --scope");
}

async function inventory(root: string, scopes: string[], excludes: string[]) {
  if (!(await Deno.lstat(root)).isDirectory) throw new Error("--root: требуется каталог");
  const ignored = new Set<string>([".git", "node_modules", ...excludes]);
  const files: string[] = [];
  const seen = new Set<string>();
  const inside = (path: string, parent: string) =>
    parent === "" || path === parent || path.startsWith(parent + "/");
  async function walk(directory: string) {
    for await (const entry of Deno.readDir(join(root, directory))) {
      const path = directory ? directory + "/" + entry.name : entry.name;
      if (
        entry.name === ".git" || entry.name === "node_modules" ||
        excludes.some((exclude) => inside(path, exclude))
      ) {
        ignored.add(path);
        continue;
      }
      if (!scopes.some((scope) => inside(path, scope) || inside(scope, path))) {
        ignored.add(path);
        continue;
      }
      seen.add(path);
      if (entry.isSymlink) {
        throw new Error(`Символьная ссылка в собственном составе требует --exclude: ${path}`);
      }
      if (entry.isDirectory) await walk(path);
      else if (
        entry.isFile && path.endsWith(".lua") && scopes.some((scope) => inside(path, scope))
      ) files.push(path);
    }
  }
  await walk("");
  for (const scope of scopes) {
    if (scope && !seen.has(scope)) throw new Error(`Не найден собственный --scope: ${scope}`);
  }
  if (files.length === 0) throw new Error("Собственный состав Lua пуст");
  return { files: files.sort(), ignored: [...ignored].sort() };
}
const temporary = await Deno.makeTempDir({ prefix: "performance-luals-" });
try {
  let workspace = options.root;
  let scopes = options.scopes.length ? options.scopes : [""];
  // @meta-декларации передаются как library; это не исполняемый Lua.
  let excludes = options.root === ownRoot && options.scopes.length === 0
    ? ["typecheck", ...options.excludes]
    : options.excludes;
  if (options.probe) {
    workspace = join(temporary, "probe");
    scopes = ["own"];
    excludes = ["own/vendor"];
    const faulty =
      "---@param value unknown\nlocal function identity(value)\n local copy=value\n return copy\nend\nreturn identity\n";
    for (const path of ["own/unknown.lua", "own/vendor/unknown.lua", "outside/unknown.lua"]) {
      await Deno.mkdir(dirname(join(workspace, path)), { recursive: true });
      await Deno.writeTextFile(join(workspace, path), faulty);
    }
  }
  const selected = await inventory(workspace, scopes, excludes);
  for (const library of options.libraries) {
    if (!(await Deno.stat(library)).isDirectory) {
      throw new Error(`--library: требуется каталог: ${library}`);
    }
  }
  const decoder = new TextDecoder();
  const version = await new Deno.Command(options.server, {
    args: ["--version"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!version.success || !/^3\.19\.2\s*$/.test(decoder.decode(version.stdout).trim())) {
    throw new Error("Требуется LuaLS 3.19.2");
  }
  const paths = await new Deno.Command(Deno.env.get("QUARTO") ?? "quarto", {
    args: ["--paths"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!paths.success) throw new Error(decoder.decode(paths.stderr));
  const share = decoder.decode(paths.stdout).trim().split(/\r?\n/)[1];
  if (!share || !isAbsolute(share)) throw new Error("Quarto не вернул абсолютный каталог share");
  const plugin = join(share, "lua-plugin/plugin.lua");
  const types = join(share, "lua-types");
  if (!(await Deno.stat(plugin)).isFile || !(await Deno.stat(types)).isDirectory) {
    throw new Error("В Quarto отсутствуют lua-plugin или lua-types");
  }
  const config = {
    "runtime.version": "Lua 5.4",
    "runtime.path": options.runtimePaths,
    "runtime.plugin": plugin,
    "workspace.library": [types, ...options.libraries],
    "workspace.ignoreDir": selected.ignored.map((path) =>
      "/" + path.replace(/[\\*?\[\]{},!#\s]/g, "\\$&")
    ),
    "workspace.useGitIgnore": false,
    "workspace.ignoreSubmodules": false,
    "diagnostics.libraryFiles": "Disable",
    "diagnostics.ignoredFiles": "Disable",
    "diagnostics.groupFileStatus": { "type-check": "Any", strong: "Any" },
    "diagnostics.groupSeverity": { "type-check": "Error", strong: "Error" },
    "diagnostics.neededFileStatus": { "no-unknown": "Any!" },
    "diagnostics.severity": { "no-unknown": "Error" },
    "type.weakNilCheck": false,
    "type.weakUnionCheck": false,
    "type.checkTableShape": true,
  };
  const configPath = join(temporary, "luarc.json");
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  const output = join(temporary, "check.json");
  const result = await new Deno.Command(options.server, {
    args: [
      `--check=${workspace}`,
      "--checklevel=Warning",
      "--check_format=json",
      `--check_out_path=${output}`,
      `--configpath=${configPath}`,
      `--logpath=${temporary}`,
      "--num_threads=1",
    ],
    cwd: workspace,
    stdout: "piped",
    stderr: "piped",
  }).output();
  console.error(decoder.decode(result.stdout), decoder.decode(result.stderr));
  const diagnostics = await Deno.readTextFile(output);
  console.log(diagnostics);
  console.error(`Собственный состав Lua: ${selected.files.length}; ${selected.files.join(", ")}`);
  if (options.probe) {
    const parsed: unknown = JSON.parse(diagnostics);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("LuaLS вернул неверный формат диагностик");
    }
    const keys = Object.keys(parsed);
    if (
      keys.length !== 1 || !keys[0]?.endsWith("/own/unknown.lua") ||
      !diagnostics.includes('"no-unknown"')
    ) throw new Error("LuaLS не подтвердил собственный canary и исключения");
    console.error(
      "PASS: выбранный no-unknown обнаружен; исключённый и чужой состав не проверялись",
    );
  } else Deno.exitCode = result.code;
} finally {
  await Deno.remove(temporary, { recursive: true });
}
