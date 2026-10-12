import { join, resolve } from "node:path";
import type { SourceManifest, Variant } from "../config/types.ts";
import { git } from "./resolve.ts";
import { verifySources } from "./prepare.ts";
import { hashFile } from "./snapshot.ts";
import { probeQuarto } from "../adapters/quarto/capabilities.ts";

export interface FreezeInputs {
  baseline: string;
  variants: Record<Variant, Record<string, string>>;
  runtimeRegistry?: { path: string; version: string };
}
/** Не перезаписывает ранее закреплённый эксперимент. Пути — доверенные локальные checkouts. */
export async function freezeVariants(inputs: FreezeInputs, workspace: string, quarto = "quarto") {
  const baseline: SourceManifest = JSON.parse(await Deno.readTextFile(inputs.baseline));
  const caps = await probeQuarto(quarto), runtime: SourceManifest["runtime"] = { ...caps.runtime };
  const hyperfine = await new Deno.Command("which", { args: ["hyperfine"], stdout: "piped" })
    .output();
  if (!hyperfine.success) throw new Error("Hyperfine не найден");
  const path = new TextDecoder().decode(hyperfine.stdout).trim();
  const version = await new Deno.Command(path, { args: ["--version"], stdout: "piped" }).output();
  runtime.hyperfine = {
    path,
    version: new TextDecoder().decode(version.stdout).trim(),
    hash: await hashFile(path),
  };
  if (inputs.runtimeRegistry) {
    const path = resolve(inputs.runtimeRegistry.path);
    runtime.runtimeRegistry = { ...inputs.runtimeRegistry, path, hash: await hashFile(path) };
  }
  const experimentId = crypto.randomUUID(),
    manifests: Partial<Record<Variant, SourceManifest>> = {};
  for (const variant of ["upstream", "clean-control", "candidate"] as const) {
    const mapping = inputs.variants[variant];
    if (!mapping || Object.keys(mapping).length !== baseline.sources.length) {
      throw new Error("Неполный набор sources");
    }
    const sources = [];
    for (const source of baseline.sources) {
      if (!mapping[source.repository]) throw new Error(`Отсутствует ${source.repository}`);
      const checkoutPath = await Deno.realPath(mapping[source.repository]);
      const sha = await git(["-C", checkoutPath, "rev-parse", "HEAD"]);
      if (variant === "upstream" && sha !== source.sha) {
        throw new Error("Upstream SHA расходится с baseline");
      }
      sources.push({
        ...source,
        checkoutPath,
        sha,
        ...(variant === "upstream" ? {} : {
          sourceKind: "local-candidate" as const,
          baseSha: source.sha,
          remoteRef: await git(["-C", checkoutPath, "rev-parse", "--abbrev-ref", "HEAD"]),
        }),
      });
    }
    const manifest: SourceManifest = { experimentId, sources, packages: [], runtime };
    await verifySources(manifest);
    manifests[variant] = manifest;
  }
  await Deno.mkdir(workspace, { recursive: true });
  for (const variant of ["upstream", "clean-control", "candidate"] as const) {
    try {
      await Deno.stat(join(workspace, variant + ".manifest.json"));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      throw e;
    }
    throw new Error("Эксперимент уже закреплён; выберите новый workspace");
  }
  for (const variant of ["upstream", "clean-control", "candidate"] as const) {
    await Deno.writeTextFile(
      join(workspace, variant + ".manifest.json"),
      JSON.stringify(manifests[variant], null, 2) + "\n",
      { createNew: true },
    );
  }
  await Deno.writeTextFile(
    join(workspace, "capabilities.json"),
    JSON.stringify(caps, null, 2) + "\n",
  );
  return manifests;
}
