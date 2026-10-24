import { isAbsolute, join } from "node:path";
import { strict as assert } from "node:assert";
import { type ChromeTrace, traces } from "../src/report/perfetto.ts";
import { controlRun } from "../tests/report/fixtures/perfetto/control.ts";

const sql = `SELECT
 (SELECT COUNT(*) FROM slice) AS slices,
 (SELECT COUNT(DISTINCT track_id) FROM slice) AS tracks,
 (SELECT COUNT(*) FROM flow) AS flows,
 (SELECT COUNT(*) FROM flow f JOIN slice a ON a.id=f.slice_out JOIN slice b ON b.id=f.slice_in
   WHERE a.name='parent' AND b.name IN ('child','remote')) AS correct_flows,
 (SELECT COUNT(*) FROM slice c JOIN slice p ON p.id=c.parent_id WHERE c.name='child' AND p.name='parent') AS nested,
 (SELECT COUNT(*) FROM slice WHERE name IN ('async-a','async-b') AND depth=0) AS siblings,
 (SELECT COUNT(DISTINCT track_id) FROM slice WHERE name IN ('async-a','async-b')) AS sibling_tracks,
 (SELECT COUNT(DISTINCT EXTRACT_ARG(arg_set_id,'args.process_id')) FROM slice) AS uuids,
 (SELECT COUNT(*) FROM thread WHERE name GLOB '*логическая дорожка*') AS named_tracks,
 (SELECT COUNT(*) FROM slice WHERE name='error' AND EXTRACT_ARG(arg_set_id,'args.status')='error') AS errors,
 (SELECT COUNT(*) FROM slice WHERE name='remote' AND EXTRACT_ARG(arg_set_id,'args.document_id')='nested/slides.qmd'
   AND EXTRACT_ARG(arg_set_id,'args.source_attributes.extension_id')='course-core') AS context,
 (SELECT COUNT(*) FROM counter) AS counters,
 (SELECT COUNT(*) FROM track WHERE type='thread_overlapping_slice') AS overflow_tracks;`;

async function query(binary: string, path: string, statement: string): Promise<number[]> {
  const output = await new Deno.Command(binary, {
    args: ["query", path, statement],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  const text = new TextDecoder().decode(output.stdout).trim();
  console.log(`${path}\n${text}`);
  const values = text.split("\n").at(-1)!.split(",").map(Number);
  assert(values.every(Number.isFinite), `Неожиданный SQL output: ${text}`);
  return values;
}
export async function checkPerfetto(binary: string, directory: string): Promise<void> {
  if (!isAbsolute(binary)) throw new Error("Нужен абсолютный путь --trace-processor");
  const version = await new Deno.Command(binary, {
    args: ["--version"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const versionText = new TextDecoder().decode(version.stdout) +
    new TextDecoder().decode(version.stderr);
  if (!version.success || !/\bv?58\.2\b/.test(versionText)) {
    throw new Error(`Ожидается Perfetto v58.2: ${versionText}`);
  }
  console.log(versionText.trim());
  await Deno.mkdir(directory, { recursive: true });
  const bundle = traces(controlRun());
  const wallPath = join(directory, "wall.trace.json");
  await Deno.writeTextFile(join(directory, "queries.sql"), sql);
  const write = async (path: string, trace: ChromeTrace) =>
    await Deno.writeTextFile(path, JSON.stringify(trace));
  await write(wallPath, bundle.wall);
  await write(join(directory, "lua-cpu.trace.json"), bundle.luaCpu);
  for (const local of bundle.localWall) await write(join(directory, local.fileName), local.trace);
  const expected = [6, 4, 2, 2, 1, 2, 2, 2, 4, 1, 1, 0, 0];
  assert.deepEqual(
    await query(binary, wallPath, sql),
    expected,
    "Импорт wall расходится с исходным контрольным примером",
  );
  for (const path of ["lua-cpu.trace.json", "local-wall-001.trace.json"]) {
    assert.deepEqual(
      await query(
        binary,
        join(directory, path),
        "SELECT COUNT(*), SUM(dur), (SELECT COUNT(*) FROM flow) FROM slice;",
      ),
      [1, path.startsWith("lua") ? 10000 : 8000, 0],
    );
  }
  // Каждый отрицательный контроль импортируется настоящим TP: gate обязан заметить порчу.
  const mutations: [string, (trace: ChromeTrace) => void][] = [
    ["lost-slice", (t) => {
      t.traceEvents = t.traceEvents.filter((e) => e.name !== "error");
    }],
    ["lost-flow", (t) => {
      t.traceEvents = t.traceEvents.filter((e) => e.ph !== "f");
    }],
    ["lost-uuid", (t) => {
      for (const e of t.traceEvents) if (e.ph === "X") delete e.args.process_id;
    }],
    ["false-nesting", (t) => {
      const a = t.traceEvents.find((e) => e.name === "async-a")!;
      const b = t.traceEvents.find((e) => e.name === "async-b")!;
      b.tid = a.tid;
    }],
  ];
  for (const [name, mutate] of mutations) {
    const trace = structuredClone(bundle.wall);
    mutate(trace);
    const path = join(directory, `${name}.trace.json`);
    await write(path, trace);
    assert.notDeepEqual(await query(binary, path, sql), expected, `Gate пропустил ${name}`);
  }
  console.log(`Perfetto v58.2: SQL и четыре отрицательных контроля пройдены. Fixture: ${wallPath}`);
}
if (import.meta.main) {
  const args = [...Deno.args];
  const value = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0 || !args[i + 1]) return undefined;
    const result = args[i + 1];
    args.splice(i, 2);
    return result;
  };
  const binary = value("--trace-processor"), output = value("--output-directory");
  if (!binary || args.length) {
    throw new Error(
      "Использование: --trace-processor /absolute/path [--output-directory /absolute/path]",
    );
  }
  const directory = output ?? await Deno.makeTempDir({ prefix: "course-perf-perfetto-" });
  try {
    await checkPerfetto(binary, directory);
  } finally {
    if (!output) await Deno.remove(directory, { recursive: true });
  }
}
