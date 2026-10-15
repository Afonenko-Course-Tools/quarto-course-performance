import { join, resolve } from "node:path";
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
  await copyTree(options.dataDir, dataDir);
  const init = join(dataDir, "init.lua"), sourceHash = await hashFile(init);
  await Deno.writeTextFile(
    init,
    `\n-- Performance: первоначальный init сохранён выше.\ndofile(${
      JSON.stringify(backend + "/src/agents/lua/init.lua")
    })\n`,
    { append: true },
  );
  const receipt: PreparationReceipt = {
    kind: "bootstrap",
    path: init,
    sourceHash,
    preparedHash: await hashFile(init),
  };
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
