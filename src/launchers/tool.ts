import { join, resolve } from "node:path";
import { preparePandocData } from "./setup.ts";
import type { ProcessExpectation } from "../report/types.ts";
const [kind, ...originalArgs] = Deno.args;
if (!["deno", "pandoc"].includes(kind)) throw new Error("Неизвестный launcher");
const env = Deno.env.toObject(), id = crypto.randomUUID();
const binary = env[kind === "deno" ? "COURSE_PERF_REAL_DENO" : "COURSE_PERF_REAL_PANDOC"];
if (!binary || binary === env[kind === "deno" ? "QUARTO_DENO" : "QUARTO_PANDOC"]) {
  throw new Error("Рекурсивный launcher");
}
const mode = env.COURSE_PERF_MODE;
const parent = env.COURSE_PERF_PROCESS_ID;
if (parent) env.COURSE_PERF_PARENT_PROCESS_ID = parent;
env.COURSE_PERF_PROCESS_ID = id;
const args = [...originalArgs];
// Deno разбирает флаги только до entry; --help после entry принадлежит программе.
let denoExecutable = false;
if (kind === "deno" && args[0] === "run") {
  const values = new Set([
    "--config",
    "-c",
    "--import-map",
    "--lock",
    "--cert",
    "--location",
    "--v8-flags",
    "--seed",
    "--env-file",
  ]);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (["--help", "-h", "--version", "-V"].includes(arg)) break;
    if (arg === "--" || !arg.startsWith("-") || arg === "-") {
      denoExecutable = true;
      break;
    }
    if (values.has(arg)) i++;
  }
}
const pandocInformational = originalArgs.some((arg) =>
  ["--help", "-h", "--version", "-v", "--dump-args"].includes(arg) ||
  /^--(?:list-|print-)/.test(arg)
);
const pandocLua = !pandocInformational &&
  originalArgs.some((arg, i) =>
    arg === "--lua-filter" || arg.startsWith("--lua-filter=") || arg === "-L" || /^-L./.test(arg) ||
    /^(?:--(?:read|write|from|to)=|-.[^ ]).*\.lua$/.test(arg) ||
    ["--read", "--write", "--from", "--to", "-f", "-t"].includes(arg) &&
      originalArgs[i + 1]?.endsWith(".lua")
  );
const requested = Boolean(mode && mode !== "off");
const activated = requested && (kind === "deno" ? denoExecutable : pandocLua);
const expectation: ProcessExpectation = {
  process_id: id,
  agent: kind === "deno" ? "ts" : "lua",
  requested,
  supported: true,
  activated,
  executed: false,
  ...(activated
    ? { summary_path: kind === "deno" ? `events/${id}/ts.summary.json` : `events/${id}/` }
    : {}),
  ...(activated && kind === "deno" && mode === "cpu"
    ? { profile_path: `profiles/${id}/cpu.cpuprofile` }
    : {}),
};
const receipt = {
  process_id: id,
  parent_process_id: parent ?? null,
  parent_link: parent ? "confirmed" : "unlinked",
  kind,
  os_pid: null as number | null,
  argv: originalArgs,
  cwd: Deno.cwd(),
  exit_code: null as number | null,
  signal: null as Deno.Signal | null,
  expectation,
};
const receiptPath = join(env.COURSE_PERF_OUTPUT_DIR ?? ".", "processes", id + ".json");
async function writeReceipt() {
  if (!requested) return;
  await Deno.mkdir(join(env.COURSE_PERF_OUTPUT_DIR, "processes"), { recursive: true });
  const temporary = receiptPath + ".tmp";
  await Deno.writeTextFile(temporary, JSON.stringify(receipt));
  await Deno.rename(temporary, receiptPath);
}
await writeReceipt();
if (mode && mode !== "off") {
  if (kind === "deno" && denoExecutable) {
    args.splice(1, 0, "--preload", env.COURSE_PERF_AGENT_TS);
    if (mode === "cpu") {
      const profiles = join(env.COURSE_PERF_OUTPUT_DIR, "profiles", id);
      await Deno.mkdir(profiles, { recursive: true });
      args.splice(1, 0, "--cpu-prof-dir", profiles, "--cpu-prof-name", "cpu.cpuprofile");
    }
  }
  if (kind === "pandoc") {
    let source = env.COURSE_PERF_SOURCE_DATA_DIR;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--data-dir") {
        if (!args[i + 1]) throw new Error("Необходимо значение --data-dir");
        source = resolve(args[i + 1]);
        args.splice(i, 2);
        i--;
      } else if (args[i].startsWith("--data-dir=")) {
        source = resolve(args[i].slice("--data-dir=".length));
        args.splice(i, 1);
        i--;
      }
    }
    let dataDir = env.COURSE_PERF_DATA_DIR;
    if (source !== env.COURSE_PERF_SOURCE_DATA_DIR) {
      dataDir = join(env.COURSE_PERF_OUTPUT_DIR, "pandoc-data", id);
      const receipt = await preparePandocData(source, dataDir, env.COURSE_PERF_INIT_LUA);
      const directory = join(env.COURSE_PERF_OUTPUT_DIR, "preparation");
      await Deno.mkdir(directory, { recursive: true });
      await Deno.writeTextFile(join(directory, id + ".json"), JSON.stringify(receipt));
    }
    args.push("--data-dir", dataDir);
  }
}
const child = new Deno.Command(binary, {
  args,
  env,
  clearEnv: true,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
receipt.os_pid = child.pid;
const forward = (signal: Deno.Signal) => {
  if (env.COURSE_PERF_OWNED_GROUP === "1") return;
  try {
    child.kill(signal);
  } catch { /* Уже завершён. */ }
};
const term = () => forward("SIGTERM"), interrupt = () => forward("SIGINT");
Deno.addSignalListener("SIGTERM", term);
Deno.addSignalListener("SIGINT", interrupt);
const status = await child.status;
Deno.removeSignalListener("SIGTERM", term);
Deno.removeSignalListener("SIGINT", interrupt);
if (requested) {
  receipt.exit_code = status.code;
  receipt.signal = status.signal;
  {
    try {
      for await (const file of Deno.readDir(join(env.COURSE_PERF_OUTPUT_DIR, "events", id))) {
        if (!file.isFile || !file.name.endsWith(".started.json")) continue;
        const started = JSON.parse(
          await Deno.readTextFile(join(env.COURSE_PERF_OUTPUT_DIR, "events", id, file.name)),
        );
        if (
          started.schema_version === 1 && started.process_id === id &&
          started.agent === expectation.agent && started.executed === true
        ) {
          expectation.activated = true;
          expectation.executed = true;
          expectation.summary_path ??= expectation.agent === "ts"
            ? `events/${id}/${started.executor_id}.summary.json`
            : `events/${id}/`;
        }
      }
    } catch { /* Отсутствие started не отменяет заранее ожидаемые summary/profile. */ }
  }
  try {
    await writeReceipt();
  } catch (error) {
    try {
      console.error(`Не удалось записать итог процесса ${id}: ${String(error)}`);
    } catch { /* Исходный native status сохраняется. */ }
  }
}
if (status.signal) {
  Deno.kill(Deno.pid, status.signal);
  await new Promise(() => {});
} else Deno.exit(status.code);
