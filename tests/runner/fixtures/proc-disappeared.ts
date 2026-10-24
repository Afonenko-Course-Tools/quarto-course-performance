import { runOwnedProcess } from "../../../src/runner/process.ts";
const [root, stage, kind] = Deno.args;
const readDir = Deno.readDir, readTextFile = Deno.readTextFile, NativeCommand = Deno.Command;
const children: Deno.ChildProcess[] = [];
let injected = false, thrown = false;
Deno.Command = class extends NativeCommand {
  override spawn() {
    const child = super.spawn();
    children.push(child);
    return child;
  }
};
Deno.readDir = ((path: string | URL) => {
  if (path !== "/proc" || injected) return readDir(path);
  if (stage === "live") {
    try {
      Deno.statSync(root + "/native-ready");
    } catch {
      return readDir(path);
    }
  }
  injected = true;
  return {
    async *[Symbol.asyncIterator]() {
      yield { name: "99999999", isDirectory: true, isFile: false, isSymlink: false };
      yield* readDir(path);
    },
  };
}) as typeof Deno.readDir;
Deno.readTextFile = ((path: string | URL, options?: Deno.ReadFileOptions) => {
  if (path === "/proc/99999999/stat" && !thrown) {
    thrown = true;
    return Promise.reject(
      kind === "permission"
        ? new Deno.errors.PermissionDenied("fixture proc permission")
        : new Error(
          kind === "io"
            ? "Input/output error (os error 5)"
            : "No such process (os error 3): readfile '/proc/99999999/stat'",
        ),
    );
  }
  return readTextFile(path, options);
}) as typeof Deno.readTextFile;
let result: unknown;
try {
  const outcome = await runOwnedProcess({
    executable: "/bin/sh",
    args: ["-c", `printf ready > '${root}/native-ready'; printf available; sleep 0.2; exit 7`],
    cwd: root,
    env: Deno.env.toObject(),
    stdoutPath: root + "/stdout.log",
    stderrPath: root + "/stderr.log",
    timeExecutable: null,
    graceMilliseconds: 100,
    stdout: new WritableStream({ write() {} }),
    stderr: new WritableStream({ write() {} }),
  });
  result = { injected, thrown, outcome };
} catch (error) {
  result = { injected, thrown, error: error instanceof Error ? error.message : String(error) };
} finally {
  Deno.readDir = readDir;
  Deno.readTextFile = readTextFile;
  Deno.Command = NativeCommand;
  for await (const entry of readDir(root)) {
    if (!entry.name.endsWith(".ready")) continue;
    const { group } = JSON.parse(await readTextFile(root + "/" + entry.name));
    try {
      Deno.kill(-group, "SIGKILL");
    } catch { /* Только собственная group fixture. */ }
  }
  await Promise.allSettled(children.map((child) => child.status));
}
await Deno.writeTextFile(root + "/result.json", JSON.stringify(result));
