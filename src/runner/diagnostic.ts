import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareLaunchers } from "../launchers/setup.ts";
import { probeQuarto } from "../adapters/quarto/capabilities.ts";
import { prepareFilterAdapter } from "../adapters/quarto/filter-trace.ts";
import { instrumentModule } from "../instrumentation/ts/transform.ts";
import { contained, hashFile } from "../sources/snapshot.ts";
import type { PreparationReceipt, PreparedVariant, Scenario } from "../config/types.ts";
export async function prepareDiagnostic(
  scenario: Scenario,
  prepared: PreparedVariant,
  workspace: string,
  quarto = "quarto",
) {
  const caps = await probeQuarto(quarto);
  if (!caps.denoPreload || !caps.luaHook) {
    throw new Error("Runtime не поддерживает необходимые launchers");
  }
  const share = join(workspace, "share"), preparation: PreparationReceipt[] = [];
  if (caps.filterAdapter) preparation.push(await prepareFilterAdapter(caps.share, share));
  const setup = await prepareLaunchers({
    workspace: join(workspace, "launchers"),
    deno: caps.deno,
    pandoc: caps.pandoc,
    dataDir: join(caps.filterAdapter ? share : caps.share, "pandoc/datadir"),
  });
  preparation.push(...setup.preparation);
  const registry = new URL("../../docs/operation-registry.json", import.meta.url).pathname;
  const coverage = {
    complete: true,
    ts: [] as unknown[],
    luaModules: [] as string[],
    runtime: caps,
    requestedExtensions: scenario.scope.extensions,
    scopeKind: scenario.mode === "trace" ? "selected-functions-and-semantic" : "semantic-registry",
    manualRegistry: {
      hash: await hashFile(registry),
      operations: JSON.parse(await Deno.readTextFile(registry)),
    },
  };
  const bridgeUrl = pathToFileURL(setup.bridgePath).href;
  for (const module of scenario.scope.modules) {
    const path = join(prepared.root, module);
    await contained(prepared.root, path);
    if (path.endsWith(".lua")) {
      coverage.luaModules.push(module);
      continue;
    }
    if (!path.endsWith(".ts")) throw new Error("Неподдержанный scope module");
    if (scenario.mode !== "trace") {
      coverage.ts.push({ path: module, instrumentation: "manual-only" });
      continue;
    }
    const source = await Deno.readTextFile(path),
      sourceHash = await hashFile(path),
      result = instrumentModule(source, module, { strict: scenario.scope.strict, bridgeUrl });
    await Deno.writeTextFile(path, result.source);
    const map = path + ".symbols.json";
    await Deno.writeTextFile(map, JSON.stringify(result.symbols));
    preparation.push({
      kind: "ts-transform",
      path,
      sourceHash,
      preparedHash: await hashFile(path),
      sourceMapPath: map,
    });
    coverage.ts.push({ path: module, symbols: result.symbols, skipped: result.skipped });
    if (result.skipped.length) coverage.complete = false;
  }
  const scopePath = join(workspace, "scope.json");
  await Deno.writeTextFile(scopePath, JSON.stringify(coverage));
  return {
    env: {
      ...setup.env,
      COURSE_PERF_SCOPE_FILE: scopePath,
      ...(caps.filterAdapter ? { QUARTO_SHARE_PATH: share } : {}),
    },
    preparation,
    coverage,
  };
}
