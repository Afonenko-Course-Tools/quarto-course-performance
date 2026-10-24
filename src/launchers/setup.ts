import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { copyTree, hashBytes, hashFile, treeHash } from "../sources/snapshot.ts";
import type { PreparationReceipt } from "../config/types.ts";
const project = new URL("../../", import.meta.url).pathname;
function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export async function prepareLaunchers(
  options: { workspace: string; deno: string; pandoc: string; dataDir: string },
) {
  const root = resolve(options.workspace);
  await Deno.mkdir(root, { recursive: true });
  const deno = await Deno.realPath(options.deno), pandoc = await Deno.realPath(options.pandoc);
  const backend = join(root, "backend");
  const before = await hashBytes(new TextEncoder().encode(JSON.stringify([
    await treeHash(join(project, "src")),
    await treeHash(join(project, "bridge")),
  ])));
  await copyTree(join(project, "src"), join(backend, "src"));
  await copyTree(join(project, "bridge"), join(backend, "bridge"));
  const after = await hashBytes(new TextEncoder().encode(JSON.stringify([
    await treeHash(join(backend, "src")),
    await treeHash(join(backend, "bridge")),
  ])));
  if (before !== after) throw new Error("Backend изменился при подготовке");
  const dataDir = join(root, "pandoc-data");
  const receipt = await preparePandocData(
    options.dataDir,
    dataDir,
    backend + "/src/agents/lua/init.lua",
  );
  for (const kind of ["deno", "pandoc"]) {
    const path = join(root, kind);
    await Deno.writeTextFile(
      path,
      `#!/bin/sh\nexec ${shellQuote(deno)} run --no-config --no-lock -A ${
        shellQuote(backend + "/src/launchers/tool.ts")
      } ${kind} "$@"\n`,
    );
    await Deno.chmod(path, 0o755);
  }
  return {
    env: {
      QUARTO_DENO: join(root, "deno"),
      QUARTO_PANDOC: join(root, "pandoc"),
      COURSE_PERF_REAL_DENO: deno,
      COURSE_PERF_REAL_PANDOC: pandoc,
      COURSE_PERF_DATA_DIR: dataDir,
      COURSE_PERF_SOURCE_DATA_DIR: resolve(options.dataDir),
      COURSE_PERF_INIT_LUA: backend + "/src/agents/lua/init.lua",
      COURSE_PERF_AGENT_LUA: backend + "/src/agents/lua/agent.lua",
      COURSE_PERF_AGENT_TS: backend + "/src/agents/ts/bootstrap.ts",
    },
    bridgePath: join(backend, "bridge/bridge.ts"),
    preparation: [receipt, {
      kind: "bootstrap" as const,
      path: backend,
      sourceHash: before,
      preparedHash: after,
    }],
  };
}

/** Копия эффективного публичного Pandoc data-dir; исходный init выполняется один раз. */
export async function preparePandocData(
  source: string,
  destination: string,
  agentInit: string,
): Promise<PreparationReceipt> {
  await copyPandocData(source, destination);
  const init = join(destination, "init.lua");
  let sourceHash = await hashBytes(new Uint8Array());
  let hasOriginal = false;
  try {
    sourceHash = await hashFile(init);
    hasOriginal = true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  let original: string | undefined;
  if (hasOriginal) {
    original = await Deno.makeTempFile({
      dir: destination,
      prefix: ".course-perf-init-",
      suffix: ".lua",
    });
    await Deno.copyFile(init, original);
    await Deno.remove(init);
  }
  // Отдельный chunk сохраняет terminal return и исходные Lua bytes.
  const loadOriginal = original
    ? `local result=table.pack(dofile(${JSON.stringify(original)}))\n`
    : "";
  const returnOriginal = original ? "return table.unpack(result,1,result.n)\n" : "";
  await Deno.writeTextFile(
    init,
    "-- Performance: публичный Pandoc init.\n" + loadOriginal +
      "dofile(" + JSON.stringify(agentInit) + ")\n" + returnOriginal,
  );
  return { kind: "bootstrap", path: init, sourceHash, preparedHash: await hashFile(init) };
}

/** Только явно выбранный runtime data-dir: ссылки материализуются без записи в source. */
async function copyPandocData(source: string, destination: string): Promise<void> {
  // Даже ещё не существующий destination разрешается через физический existing ancestor.
  let existing = isAbsolute(destination) ? destination : Deno.cwd() + "/" + destination;
  const suffix: string[] = [];
  let physicalDestination: string;
  while (true) {
    try {
      physicalDestination = join(await Deno.realPath(existing), ...suffix);
      break;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      const present = await Deno.lstat(existing).then(() => true, (statError) => {
        if (statError instanceof Deno.errors.NotFound) return false;
        throw statError;
      });
      if (present || dirname(existing) === existing) throw error;
      suffix.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  const inside = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === "" || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
  };
  const entries: { source: string; target: string; info: Deno.FileInfo }[] = [];
  // Сначала проверяется всё достижимое дерево. До завершения этого обхода записей нет.
  async function inspect(from: string, to: string, ancestors: Set<string>): Promise<void> {
    const real = await Deno.realPath(from), info = await Deno.stat(real);
    if (info.isDirectory && ancestors.has(real)) {
      throw new Error(`Цикл символических ссылок Pandoc data-dir: ${from}`);
    }
    if (inside(real, physicalDestination) || inside(physicalDestination, real)) {
      throw new Error(
        `Копия Pandoc data-dir не может находиться внутри источника или пересекаться с достижимым путём: ${from}`,
      );
    }
    if (!info.isDirectory && !info.isFile) {
      throw new Error(`Специальный файл в Pandoc data-dir: ${from}`);
    }
    entries.push({ source: real, target: to, info });
    if (info.isDirectory) {
      const next = new Set(ancestors);
      next.add(real);
      for await (const entry of Deno.readDir(real)) {
        await inspect(join(real, entry.name), join(to, entry.name), next);
      }
    }
  }
  await inspect(source, physicalDestination, new Set());
  for (const { source: from, target: to, info } of entries) {
    if (info.isDirectory) await Deno.mkdir(to, { recursive: true });
    else {
      await Deno.copyFile(from, to);
      if (info.mode !== null) await Deno.chmod(to, info.mode & 0o777);
      if (info.mtime !== null) await Deno.utime(to, info.atime ?? info.mtime, info.mtime);
    }
  }
}
