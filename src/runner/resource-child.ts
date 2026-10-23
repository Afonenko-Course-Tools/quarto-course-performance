// Помощник GNU time и протокол собственной Linux group.
export async function publishReceipt(
  path: string,
  value: unknown,
  write: (path: string, data: string) => Promise<void> = Deno.writeTextFile,
): Promise<void> {
  const temporary = path + "." + crypto.randomUUID() + ".tmp";
  await write(temporary, JSON.stringify(value));
  await Deno.rename(temporary, path);
}

async function main() {
  const owned = Deno.args[0] === "--owned";
  const [receipt, executable, ...args] = Deno.args.slice(owned ? 1 : 0);
  if (!receipt || !executable) throw new Error("Необходимы status receipt и executable");
  const start = performance.now();
  const listeners = (["SIGTERM", "SIGINT"] as const).map((signal) => {
    const listener = () => {
      if (owned) {
        // PTY уже доставил сигнал всей native group: только уведомление supervisor.
        const temporary = receipt + ".signal." + crypto.randomUUID() + ".tmp";
        Deno.writeTextFileSync(temporary, JSON.stringify({ signal }));
        Deno.renameSync(temporary, receipt + ".signal");
      } else if (Deno.env.get("COURSE_PERF_OWNED_GROUP") !== "1") {
        try {
          child.kill(signal);
        } catch { /* Уже завершён. */ }
      }
    };
    Deno.addSignalListener(signal, listener);
    return { signal, listener };
  });
  const child = new Deno.Command(executable, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  if (owned) {
    const stat = await Deno.readTextFile("/proc/self/stat");
    const group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    await publishReceipt(receipt + ".ready", { group });
  }
  const status = await child.status;
  const toolWallSeconds = (performance.now() - start) / 1000;
  for (const { signal, listener } of listeners) Deno.removeSignalListener(signal, listener);
  await publishReceipt(receipt, { code: status.code, signal: status.signal, toolWallSeconds });
  Deno.exit(status.code);
}
if (import.meta.main) await main();
