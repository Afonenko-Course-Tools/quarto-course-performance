import { join, resolve } from "node:path";
import { probeQuarto } from "../adapters/quarto/capabilities.ts";
import { type SourceManifest, validateSourceSelection, type Variant } from "../config/types.ts";
import { object, string } from "../json.ts";
import { verifySources } from "./prepare.ts";
import { git } from "./git.ts";

export interface FreezeInputs {
  projectSource: string;
  variants: Record<Variant, string>;
  runtimeRegistry?: { path: string; version: string };
}
export function validateFreezeInputs(value: unknown): FreezeInputs {
  const input = object(value, "freeze inputs");
  if (
    Object.keys(input).some((key) =>
      !["projectSource", "variants", "runtimeRegistry"].includes(key)
    )
  ) {
    throw new Error("Неизвестное поле freeze inputs; baseline и source lock удалены");
  }
  const variants = object(input.variants, "variants");
  if (
    Object.keys(variants).some((key) => !["upstream", "clean-control", "candidate"].includes(key))
  ) {
    throw new Error("Неизвестный variant");
  }
  return {
    projectSource: string(input.projectSource, "projectSource"),
    variants: {
      upstream: string(variants.upstream, "upstream"),
      "clean-control": string(variants["clean-control"], "clean-control"),
      candidate: string(variants.candidate, "candidate"),
    },
    ...(input.runtimeRegistry === undefined ? {} : {
      runtimeRegistry: {
        path: string(object(input.runtimeRegistry).path),
        version: string(object(input.runtimeRegistry).version),
      },
    }),
  };
}
/** Не перезаписывает ранее закреплённый эксперимент. Пути — доверенные локальные checkouts. */
export async function freezeVariants(inputs: FreezeInputs, workspace: string, quarto = "quarto") {
  validateSourceSelection({
    projectSource: inputs.projectSource,
    sources: [{ repository: inputs.projectSource }],
  });
  const caps = await probeQuarto(quarto), runtime: SourceManifest["runtime"] = { ...caps.runtime };
  if (inputs.runtimeRegistry) {
    const path = resolve(inputs.runtimeRegistry.path);
    runtime.runtimeRegistry = { ...inputs.runtimeRegistry, path };
  }
  const experimentId = crypto.randomUUID(),
    manifests: Partial<Record<Variant, SourceManifest>> = {};
  for (const variant of ["upstream", "clean-control", "candidate"] as const) {
    const checkoutPath = await Deno.realPath(inputs.variants[variant]);
    const repository = inputs.projectSource;
    const sha = await git(["-C", checkoutPath, "rev-parse", "HEAD"]);
    const sources = [{
      repository,
      checkoutPath,
      sha,
      sourceKind: "local-candidate" as const,
      remoteRef: await git(["-C", checkoutPath, "rev-parse", "--abbrev-ref", "HEAD"]),
      fetchedAt: new Date().toISOString(),
    }];
    const manifest: SourceManifest = {
      schema_version: 2,
      projectSource: inputs.projectSource,
      experimentId,
      sources,
      packages: [],
      runtime,
    };
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
