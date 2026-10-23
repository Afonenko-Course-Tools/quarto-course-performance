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

export function readCancellation(path: string): Deno.Signal | undefined {
  try {
    const value = JSON.parse(Deno.readTextFileSync(path));
    if (value.signal !== "SIGINT" && value.signal !== "SIGTERM") {
      throw new Error("Некорректный cancellation receipt");
    }
    return value.signal;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}
export function recordCancellation(path: string, signal: Deno.Signal): void {
  if (readCancellation(path)) return;
  const temporary = path + "." + crypto.randomUUID() + ".tmp";
  Deno.writeTextFileSync(temporary, JSON.stringify({ signal }));
  Deno.renameSync(temporary, path);
}

async function main() {
  const owned = Deno.args[0] === "--owned";
  const [receipt, executable, ...args] = Deno.args.slice(owned ? 1 : 0);
  if (!receipt || !executable) throw new Error("Необходимы status receipt и executable");
  const start = performance.now();
  const ownsGroup = owned || Deno.env.get("COURSE_PERF_OWNED_GROUP") === "1";
  const cancelPath = Deno.env.get("COURSE_PERF_CANCEL_PATH") ?? receipt + ".cancel";
  const spawnLock = Deno.env.get("COURSE_PERF_SPAWN_LOCK") ?? receipt + ".spawn-lock";
  let child: Deno.ChildProcess | undefined;
  let received: "SIGINT" | "SIGTERM" | undefined;
  const listeners = (["SIGTERM", "SIGINT"] as const).map((signal) => {
    const listener = () => {
      if (ownsGroup) {
        received = signal;
        recordCancellation(cancelPath, signal);
      }
      if (owned) {
        // PTY уже доставил сигнал всей native group: только уведомление supervisor.
        const temporary = receipt + ".signal." + crypto.randomUUID() + ".tmp";
        Deno.writeTextFileSync(temporary, JSON.stringify({ signal }));
        Deno.renameSync(temporary, receipt + ".signal");
      } else if (Deno.env.get("COURSE_PERF_OWNED_GROUP") !== "1") {
        try {
          child?.kill(signal);
        } catch { /* Уже завершён. */ }
      }
    };
    Deno.addSignalListener(signal, listener);
    return { signal, listener };
  });
  if (owned) {
    const stat = await Deno.readTextFile("/proc/self/stat");
    const group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    await publishReceipt(receipt + ".ready", { group });
    // Native не может исчезнуть вместе с parent-chain до подтверждения ownership.
    while (true) {
      try {
        await Deno.stat(receipt + ".registered");
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  const finish = async (status: { code: number; signal: Deno.Signal | null }): Promise<never> => {
    await publishReceipt(receipt, {
      ...status,
      toolWallSeconds: (performance.now() - start) / 1000,
    });
    for (const { signal, listener } of listeners) Deno.removeSignalListener(signal, listener);
    Deno.exit(status.code);
  };
  const cancelled = () => received ?? readCancellation(cancelPath);
  if (ownsGroup) {
    while (true) {
      const signal = cancelled();
      if (signal) return await finish({ code: signal === "SIGINT" ? 130 : 143, signal });
      try {
        Deno.mkdirSync(spawnLock);
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    let signal: Deno.Signal | undefined;
    try {
      // Только sync check + spawn под lock. Cancel/grace supervisor lock не ждут.
      signal = cancelled();
      if (!signal) {
        child = new Deno.Command(executable, {
          args,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }).spawn();
      }
    } finally {
      Deno.removeSync(spawnLock);
    }
    if (signal) return await finish({ code: signal === "SIGINT" ? 130 : 143, signal });
  } else {
    child = new Deno.Command(executable, {
      args,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
  }
  if (owned || Deno.env.get("COURSE_PERF_OWNED_GROUP") === "1") {
    await publishReceipt(receipt + ".started", {});
  }
  return await finish(await child!.status);
}
if (import.meta.main) await main();
