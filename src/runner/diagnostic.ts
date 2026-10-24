import { assetPath } from "../assets.ts";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareLaunchers } from "../launchers/setup.ts";
import { probeQuarto } from "../adapters/quarto/capabilities.ts";
import { prepareFilterAdapter } from "../adapters/quarto/filter-trace.ts";
import { contained, hashFile } from "../sources/snapshot.ts";
import type { NativeRenderRequest } from "../report/types.ts";
import type { ProjectTarget } from "../adapters/quarto/inspect.ts";
import { validateTelemetryEnvironment } from "./environment.ts";
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
  const registry = assetPath("docs/operation-registry.json");
  const coverage = {
    complete: false,
    installed: { ts: true, lua: true },
    instrumented: { ts: true, lua: true },
    observed: { ts: false, lua: false },
    integrity: "pending",
    ts: [] as unknown[],
    luaModules: [] as string[],
    runtime: caps,
    requestedExtensions: scenario.scope.extensions,
    scopeKind: scenario.mode === "trace" ? "selected-functions-and-semantic" : "semantic-registry",
    observationPolicy: {
      perNodeHandlers: scenario.mode === "trace" ? "enabled" : "not-requested",
      documentPhases: "enabled",
      shortcodeBoundaries: "enabled",
    },
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
      coverage.luaModules.push(path);
      continue;
    }
    if (!path.endsWith(".ts")) throw new Error("Неподдержанный scope module");
    if (scenario.mode !== "trace") {
      coverage.ts.push({ path: module, instrumentation: "manual-only" });
      continue;
    }
    const { instrumentModule } = await import("../instrumentation/ts/transform.ts");
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

/** Простое подключение использует только публичные hooks выбранного runtime. */
export async function prepareRenderDiagnostic(
  request: NativeRenderRequest,
  target: ProjectTarget,
  workspace: string,
) {
  if (request.mode === "off") throw new Error("Режим off не требует диагностического агента");
  const environment = Deno.env.toObject();
  const conflicts = validateTelemetryEnvironment(environment);
  for (const key of ["QUARTO_DENO_EXTRA_OPTIONS", "QUARTO_DENO_V8_OPTIONS"]) {
    if (/--(?:cpu-prof|prof|inspect)(?:[=\s-]|$)/.test(environment[key] ?? "")) conflicts.push(key);
  }
  if (conflicts.length) throw new Error(`Конфликт окружения измерений: ${conflicts.join(", ")}`);
  const caps = await probeQuarto(request.quarto);
  if (!caps.denoPreload || !caps.luaHook || request.mode === "cpu" && !caps.denoCpu) {
    throw new Error(
      "Выбранный runtime не поддерживает публичные Deno preload/Pandoc init или CPU profile; проверьте QUARTO_DENO/QUARTO_PANDOC",
    );
  }
  const setup = await prepareLaunchers({
    workspace,
    deno: caps.deno,
    pandoc: caps.pandoc,
    dataDir: join(caps.share, "pandoc/datadir"),
  });
  return {
    env: setup.env,
    preparation: setup.preparation,
    coverage: {
      complete: false,
      installed: { ts: true, lua: true },
      instrumented: { ts: true, lua: true },
      observed: { ts: false, lua: false },
      integrity: "pending",
      scopeKind: "semantic-registry",
      target,
      runtime: caps,
      hooks: { denoPreload: true, pandocInit: true },
      operations: {
        "quarto.filter.run": { available: false, reason: "experiment-only-private-adapter" },
      },
    },
  };
}
