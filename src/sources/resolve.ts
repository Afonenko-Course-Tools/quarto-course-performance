import type { PerformanceConfig } from "../config/validate.ts";
import { join } from "node:path";
import { liveSourceManifest, type SourceManifest, type SourceRequest } from "../config/types.ts";
export async function git(args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).trim();
}
export function selectRemoteRef(output: string, request: SourceRequest) {
  const lines = output.trim().split("\n");
  const remoteRef = request.refPolicy === "remote-default-head"
    ? lines.find((x) => /^ref: refs\/\S+\s+HEAD$/.test(x))?.split(/\s+/)[1]
    : request.ref;
  if (!remoteRef) throw new Error("Удалённый ref отсутствует");
  const rows = lines.filter((x) => /^[0-9a-f]{40}\s/.test(x)).map((x) => x.split(/\s+/));
  const target = request.refPolicy === "remote-default-head" ? "HEAD" : remoteRef;
  const peeled = rows.filter((x) => x[1] === target + "^{}");
  const matches = peeled.length ? peeled : rows.filter((x) => x[1] === target);
  if (matches.length !== 1) throw new Error("Удалённый ref не найден или неоднозначен");
  return { sha: matches[0][0], remoteRef };
}
export async function resolveSources(
  config: Pick<PerformanceConfig, "sources" | "projectSource" | "replacements">,
  workspace: string,
): Promise<SourceManifest> {
  const requests = config.sources;
  const path = join(workspace, "manifest.json");
  try {
    const frozen = liveSourceManifest(JSON.parse(await Deno.readTextFile(path)));
    if (
      frozen.projectSource !== config.projectSource ||
      JSON.stringify(frozen.replacements) !== JSON.stringify(config.replacements) ||
      JSON.stringify(frozen.sources.map((s) => s.repository).sort()) !==
        JSON.stringify(requests.map((s) => s.repository).sort()) ||
      requests.some((r) =>
        r.refPolicy === "explicit-remote-ref" &&
        !frozen.sources.some((s) => s.repository === r.repository && s.remoteRef === r.ref)
      )
    ) throw new Error("Запрос расходится с замороженным manifest");
    return frozen;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  await Deno.mkdir(workspace, { recursive: true });
  const manifest: SourceManifest = {
    schema_version: 2,
    projectSource: config.projectSource,
    replacements: config.replacements,
    experimentId: crypto.randomUUID(),
    sources: [],
    packages: [],
    runtime: {},
  };
  for (const request of requests) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(request.repository)) {
      throw new Error("Некорректный GitHub repository");
    }
    const url = `https://github.com/${request.repository}.git`;
    const refs = await git([
      "ls-remote",
      "--symref",
      url,
      request.refPolicy === "remote-default-head" ? "HEAD" : request.ref!,
      ...(request.refPolicy === "explicit-remote-ref" ? [request.ref! + "^{}"] : []),
    ]);
    const { sha, remoteRef } = selectRemoteRef(refs, request);
    const checkoutPath = join(workspace, request.repository.replace("/", "--"));
    await git(["clone", "--no-checkout", url, checkoutPath]);
    await git(["-C", checkoutPath, "checkout", "--detach", sha]);
    if (await git(["-C", checkoutPath, "rev-parse", "HEAD"]) !== sha) {
      throw new Error("Checkout SHA расходится");
    }
    manifest.sources.push({
      repository: request.repository,
      sourceKind: "github-baseline",
      remoteRef,
      sha,
      fetchedAt: new Date().toISOString(),
      checkoutPath,
    });
  }
  await Deno.writeTextFile(path, JSON.stringify(manifest, null, 2) + "\n", { createNew: true });
  return manifest;
}
