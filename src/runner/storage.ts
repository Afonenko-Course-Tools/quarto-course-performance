import { dirname, join, matchesGlob, parse, relative, resolve } from "node:path";
import type { NativeRenderRequest, RunRecord } from "../report/types.ts";
import type { ProjectTarget } from "../adapters/quarto/inspect.ts";
import { writeRunArtifacts } from "../report/run.ts";
import type { RunPaths } from "../config/types.ts";
export type { RunPaths } from "../config/types.ts";

async function safeDirectory(path: string): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    try {
      await Deno.mkdir(current);
    } catch (e) {
      if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    }
    const stat = await Deno.lstat(current);
    if (!stat.isDirectory || stat.isSymlink) {
      throw new Error(`Недопустимый каталог результата: ${current}`);
    }
  }
}
export async function prepareRunStorage(
  request: NativeRenderRequest,
  target: ProjectTarget,
): Promise<RunPaths> {
  const parent = request.outputParent === undefined
    ? join(target.projectRoot, ".quarto/course-perf/runs")
    : resolve(request.cwd, request.outputParent);
  const rel = relative(target.projectRoot, parent);
  // Quarto исключает служебный .quarto из копирования ресурсов, включая resources:["**"].
  if (rel !== ".quarto" && !rel.startsWith(".quarto/")) {
    let included = false;
    for (const pattern of target.resources ?? []) {
      const negate = pattern.startsWith("!");
      const raw = negate ? pattern.slice(1) : pattern;
      const glob = raw === "." ? "**" : raw.replace(/^\.\//, "").replace(/\/$/, "");
      const wildcard = glob.search(/[*?\[\]{]/);
      if (negate) {
        // Только исключение всего поддерева разрешает output: частичное
        // исключение events/*.jsonl не защищает logs и будущие артефакты.
        const subtree = glob.endsWith("/**") ? glob.slice(0, -3) : glob;
        if ((wildcard < 0 || glob === "**" || glob.endsWith("/**")) && matchesGlob(rel, subtree)) {
          included = false;
        } else if (wildcard < 0 && parent.startsWith(resolve(target.projectRoot, glob) + "/")) {
          included = false;
        }
        continue;
      }
      // Консервативное пересечение каталогов: заранее нельзя перечислить
      // все имена raw/profile/receipt. Native glob с общей статической
      // частью может включить любой из будущих материалов запуска.
      const prefix = wildcard < 0 ? glob : glob.slice(0, wildcard).replace(/[^/]*$/, "");
      const resourceRoot = resolve(target.projectRoot, prefix);
      if (
        parent === resourceRoot || parent.startsWith(resourceRoot + "/") ||
        resourceRoot.startsWith(parent + "/")
      ) included = true;
    }
    if (included) {
      throw new Error(`Каталог perf-output может попасть в project.resources: ${parent}`);
    }
  }
  await safeDirectory(parent);
  const probe = await Deno.makeTempFile({ dir: parent, prefix: ".course-perf-check-" });
  await Deno.remove(probe);
  const projectRoot = await Deno.realPath(target.projectRoot);
  let stagingDirectory: string | undefined;
  for (
    const candidate of new Set(
      [Deno.env.get("TMPDIR"), "/tmp", "/var/tmp"].filter((p): p is string => Boolean(p)),
    )
  ) {
    try {
      const tempRoot = await Deno.realPath(candidate), rel = relative(projectRoot, tempRoot);
      if (rel !== ".." && !rel.startsWith("../")) continue;
      stagingDirectory = await Deno.makeTempDir({ dir: tempRoot, prefix: "quarto-course-perf-" });
      break;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound) && !(e instanceof Deno.errors.PermissionDenied)) {
        throw e;
      }
    }
  }
  if (!stagingDirectory) throw new Error("Нет доступного внешнего каталога staging вне проекта");
  const runId = crypto.randomUUID();
  return { runId, stagingDirectory, finalDirectory: join(parent, runId) };
}
async function copyDirectory(source: string, target: string): Promise<void> {
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name), to = join(target, entry.name);
    const stat = await Deno.lstat(from);
    if (stat.isSymlink) throw new Error(`Символическая ссылка в материалах запуска: ${from}`);
    if (stat.isDirectory) {
      await Deno.mkdir(to);
      await copyDirectory(from, to);
    } else if (stat.isFile) await Deno.copyFile(from, to);
    else throw new Error(`Неподдерживаемый материал запуска: ${from}`);
  }
}
async function validateMaterials(directory: string): Promise<void> {
  const root = await Deno.lstat(directory);
  if (!root.isDirectory || root.isSymlink) throw new Error(`Недопустимый staging: ${directory}`);
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name), stat = await Deno.lstat(path);
    if (stat.isSymlink || !stat.isFile && !stat.isDirectory) {
      throw new Error(`Недопустимый материал запуска: ${path}`);
    }
    if (stat.isDirectory) await validateMaterials(path);
  }
}
async function validateReportTargets(directory: string): Promise<void> {
  const root = await Deno.lstat(directory);
  if (!root.isDirectory || root.isSymlink) throw new Error(`Недопустимый staging: ${directory}`);
  for (const name of ["run.json", "summary.json", "report.md"]) {
    try {
      const stat = await Deno.lstat(join(directory, name));
      if (!stat.isFile || stat.isSymlink) throw new Error(`Недопустимый файл отчёта: ${name}`);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}
export async function finalizeRun(paths: RunPaths, record: RunRecord): Promise<string> {
  try {
    await validateReportTargets(paths.stagingDirectory);
    await writeRunArtifacts(paths.stagingDirectory, {
      ...record,
      outputDirectory: paths.finalDirectory,
    });
    await validateMaterials(paths.stagingDirectory);
    await safeDirectory(dirname(paths.finalDirectory));
    // mkdir без recursive не позволяет затереть чужой запуск, файл или ссылку.
    await Deno.mkdir(paths.finalDirectory);
    await copyDirectory(paths.stagingDirectory, paths.finalDirectory);
  } catch (error) {
    throw new Error(
      `Не удалось сохранить итоговый отчёт; staging сохранён: ${paths.stagingDirectory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  // Полный final уже сохранён. Частичная ошибка cleanup не отменяет этот результат.
  try {
    await Deno.remove(paths.stagingDirectory, { recursive: true });
  } catch (error) {
    try {
      console.error(
        `Итоговый отчёт сохранён: ${paths.finalDirectory}; не удалось полностью очистить остаток staging: ${paths.stagingDirectory}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } catch { /* Недоступный stderr не отменяет уже сохранённый полный final. */ }
  }
  return paths.finalDirectory;
}
