import { OwnedProcessError, runOwnedProcess } from "../../../src/runner/process.ts";
const [root, kind, stage] = Deno.args;
const readDir = Deno.readDir, readTextFile = Deno.readTextFile;
let injected = false;
Deno.readDir = ((path: string | URL) => {
  if (path !== "/proc") return readDir(path);
  let ready = false;
  try {
    ready = stage === "registration"
      ? [...Deno.readDirSync(root)].some((e) => e.name.endsWith(".ready"))
      : stage === "complete"
      ? [...Deno.readDirSync(root)].some((e) => /^status-.*\.json$/.test(e.name))
      : Deno.statSync(root + "/heartbeat").size > 0;
  } catch { /* Native ещё не запущен. */ }
  if (!ready) return readDir(path);
  injected = true;
  if (kind === "enumeration") {
    return {
      async *[Symbol.asyncIterator]() {
        throw new Deno.errors.PermissionDenied("persistent proc enumeration");
      },
    };
  }
  return {
    async *[Symbol.asyncIterator]() {
      yield { name: "99999999", isDirectory: true, isFile: false, isSymlink: false };
      yield* readDir(path);
    },
  };
}) as typeof Deno.readDir;
Deno.readTextFile = ((path: string | URL, options?: Deno.ReadFileOptions) => {
  if (path === "/proc/99999999/stat") {
    return Promise.reject(
      kind === "permission"
        ? new Deno.errors.PermissionDenied("persistent proc permission")
        : new Error("persistent Input/output error (os error 5)"),
    );
  }
  return readTextFile(path, options);
}) as typeof Deno.readTextFile;
const sibling = new Deno.Command("sleep", { args: ["30"] }).spawn();
const Command = Deno.Command;
let stdoutEof = false, stderrEof = false;
Deno.Command = class extends Command {
  override spawn() {
    const child = super.spawn();
    if (stage !== "registration") return child;
    const stdout = child.stdout.pipeThrough(
      new TransformStream({
        flush() {
          stdoutEof = true;
        },
      }),
    );
    const stderr = child.stderr.pipeThrough(
      new TransformStream({
        flush() {
          stderrEof = true;
        },
      }),
    );
    return new Proxy(child, {
      get(target, key) {
        if (key === "stdout") return stdout;
        if (key === "stderr") return stderr;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
};
const kill = Deno.kill;
const groupSignals: number[] = [];
Deno.kill = ((pid: number, signal: Deno.Signal | number) => {
  if (pid < 0) groupSignals.push(pid);
  return kill(pid, signal);
}) as typeof Deno.kill;
const beat = `while :; do printf x >> '${root}/heartbeat'; sleep 0.01; done`;
const watchdog = setTimeout(async () => {
  for await (const entry of readDir(root)) {
    if (!entry.name.endsWith(".ready")) continue;
    const { group } = JSON.parse(await readTextFile(root + "/" + entry.name));
    try {
      Deno.kill(-group, "SIGKILL");
    } catch { /* Собственная group. */ }
  }
  try {
    sibling.kill("SIGKILL");
  } catch { /* Собственный sibling. */ }
  console.error("supervisor fixture watchdog: stop/wait/drain did not finish");
  Deno.exit(91);
}, 4000);
let result;
try {
  await runOwnedProcess({
    executable: "/bin/sh",
    args: [
      "-c",
      stage === "complete"
        ? `printf available; (${beat}) >/dev/null 2>&1 & exit 7`
        : `printf available; ${beat}`,
    ],
    cwd: root,
    env: Deno.env.toObject(),
    stdoutPath: root + "/stdout.log",
    stderrPath: root + "/stderr.log",
    timeExecutable: null,
    graceMilliseconds: 50,
    stdout: new WritableStream({ write() {} }),
    stderr: new WritableStream({ write() {} }),
  });
  result = { unexpectedSuccess: true };
} catch (error) {
  const before = await Deno.stat(root + "/heartbeat").then((s) => s.size, () => 0);
  await new Promise((r) => setTimeout(r, 100));
  const after = await Deno.stat(root + "/heartbeat").then((s) => s.size, () => 0);
  let siblingAlive = true;
  try {
    Deno.kill(sibling.pid, 0);
  } catch {
    siblingAlive = false;
  }
  const entries = [...Deno.readDirSync(root)];
  const ready = entries.find((e) => e.name.endsWith(".ready"));
  let helperAlive = false;
  if (ready) {
    const { group } = JSON.parse(await readTextFile(root + "/" + ready.name));
    try {
      kill(group, 0);
      helperAlive = true;
    } catch { /* Own helper reaped. */ }
  }
  result = {
    stdoutEof,
    stderrEof,
    helperAlive,
    groupSignals: [...groupSignals],
    nativeStarted: entries.some((e) => e.name.endsWith(".started")),
    nativeOutcomeKnown: error instanceof OwnedProcessError && error.outcome !== undefined,
    injected,
    error: String(error),
    controlled: error instanceof OwnedProcessError,
    nativeCode: error instanceof OwnedProcessError ? error.outcome?.code : undefined,
    before,
    after,
    siblingAlive,
  };
} finally {
  clearTimeout(watchdog);
  Deno.Command = Command;
  Deno.kill = kill;
  Deno.readDir = readDir;
  Deno.readTextFile = readTextFile;
  // Только аварийная страховка fixture, ПОСЛЕ проверки heartbeat после return.
  for await (const entry of readDir(root)) {
    if (!entry.name.endsWith(".ready")) continue;
    const { group } = JSON.parse(await readTextFile(root + "/" + entry.name));
    try {
      Deno.kill(-group, "SIGKILL");
    } catch { /* Уже остановлен. */ }
  }
  try {
    sibling.kill("SIGKILL");
  } catch { /* Уже остановлен. */ }
  await sibling.status;
}
await Deno.writeTextFile(root + "/result.json", JSON.stringify(result));
