import { runOwnedProcess } from "../../../src/runner/process.ts";
const root = Deno.args[0];
const fault = Deno.args[1] === "failure";
const doubleEmpty = Deno.args[1] === "double-empty";
let staleEntries: Deno.DirEntry[] | undefined, repeated = false;
let injectedSnapshots = 0;
const NativeCommand = Deno.Command;
let ownedDone: Promise<Deno.CommandStatus> | undefined;
Deno.Command = class extends NativeCommand {
  constructor(readonly command: string | URL, options?: Deno.CommandOptions) {
    super(command, options);
  }
  override spawn() {
    const child = super.spawn();
    if (this.command === "setsid") ownedDone = child.status;
    return child;
  }
};
const readDir = Deno.readDir;
let injected = false;
Deno.readDir = ((path: string | URL) => {
  if (path !== "/proc") return readDir(path);
  if (injected) {
    if (doubleEmpty && !repeated && staleEntries) {
      repeated = true;
      return {
        async *[Symbol.asyncIterator]() {
          injectedSnapshots++;
          for (const entry of staleEntries!) yield entry;
        },
      };
    }
    return readDir(path);
  }
  try {
    Deno.statSync(root + "/parent-ready");
  } catch {
    return readDir(path);
  }
  if (fault) {
    try {
      Deno.statSync(root + "/failed");
    } catch {
      return readDir(path);
    }
  }
  injected = true;
  const entries = [...Deno.readDirSync("/proc")];
  staleEntries = entries;
  return {
    async *[Symbol.asyncIterator]() {
      injectedSnapshots++;
      Deno.writeTextFileSync(root + "/release", "");
      await ownedDone;
      const ready = [...Deno.readDirSync(root)].find((e) => e.name.endsWith(".ready"))!;
      const { group } = JSON.parse(Deno.readTextFileSync(root + "/" + ready.name));
      let kernelExists = true;
      try {
        Deno.kill(-group, 0);
      } catch {
        kernelExists = false;
      }
      const processes = [];
      for (const entry of Deno.readDirSync("/proc")) {
        if (!/^\d+$/.test(entry.name)) continue;
        try {
          const stat = Deno.readTextFileSync(`/proc/${entry.name}/stat`),
            fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (Number(fields[2]) === group) {
            processes.push({
              pid: Number(entry.name),
              state: fields[0],
              stat,
              presentInSnapshot: entries.some((e) => e.name === entry.name),
            });
          }
        } catch { /* Process can exit while observing. */ }
      }
      Deno.writeTextFileSync(
        root + "/flight.json",
        JSON.stringify(
          {
            group,
            kernelExists,
            processes,
            enumerated: entries.map((e) => e.name),
          },
          null,
          2,
        ),
      );
      for (const entry of entries) yield entry;
    },
  };
}) as typeof Deno.readDir;
const native = fault
  ? `trap '' HUP TERM INT; printf parent-ready > "$1/parent-ready"; printf fail-trigger; while [ ! -e "$1/release" ]; do sleep 0.01; done; (printf child-start > "$1/child-start"; while :; do printf x >> "$1/beat"; sleep 0.01; done) & exit 7`
  : `trap '' HUP; printf parent-ready > "$1/parent-ready"; while [ ! -e "$1/release" ]; do sleep 0.01; done; (printf child-start > "$1/child-start"; sleep 0.7; printf done > "$1/done") & exit 7`;
let outcome, error: unknown;
try {
  outcome = await runOwnedProcess({
    executable: "/bin/sh",
    args: ["-c", native, "sh", root],
    cwd: root,
    env: Deno.env.toObject(),
    stdoutPath: root + "/out",
    stderrPath: root + "/err",
    timeExecutable: null,
    graceMilliseconds: 150,
    ...(fault
      ? {
        stdout: new WritableStream<Uint8Array>({
          write(chunk) {
            if (new TextDecoder().decode(chunk).includes("fail-trigger")) {
              Deno.writeTextFileSync(root + "/failed", "");
              throw new Error("stale error-path downstream");
            }
          },
        }),
      }
      : {}),
  });
} catch (caught) {
  error = caught;
  outcome = (caught as { outcome?: unknown }).outcome;
  if (!fault) throw caught;
}
let doneAtReturn = false;
try {
  doneAtReturn = Deno.statSync(root + "/done").isFile;
} catch { /* Return before live descendant finishes. */ }
Deno.writeTextFileSync(
  root + "/result.json",
  JSON.stringify(
    { outcome, doneAtReturn, injectedSnapshots, error: error ? String(error) : undefined },
    null,
    2,
  ),
);
