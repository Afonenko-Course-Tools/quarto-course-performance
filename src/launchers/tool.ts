import { join, resolve } from "node:path";
import { preparePandocData } from "./setup.ts";
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
if (mode && mode !== "off") {
  if (kind === "deno" && args[0] === "run") {
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
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
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
if (mode && mode !== "off") {
  const path = join(env.COURSE_PERF_OUTPUT_DIR, "processes");
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(
    join(path, id + ".json"),
    JSON.stringify({
      process_id: id,
      parent_process_id: parent ?? null,
      parent_link: parent ? "confirmed" : "unlinked",
      kind,
      os_pid: child.pid,
      argv: originalArgs,
      cwd: Deno.cwd(),
      exit_code: status.code,
      signal: status.signal,
    }),
  );
}
if (status.signal) {
  Deno.kill(Deno.pid, status.signal);
  await new Promise(() => {});
} else Deno.exit(status.code);
