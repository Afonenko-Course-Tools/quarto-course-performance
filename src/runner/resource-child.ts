// Внешний помощник GNU time: сохраняет native child status без вывода в stdout/stderr.
// Не используется в Hyperfine benchmark и не устанавливается в owner packages.
const owned = Deno.args[0] === "--owned";
const [receipt, executable, ...args] = Deno.args.slice(owned ? 1 : 0);
if (!receipt || !executable) throw new Error("Необходимы status receipt и executable");
const start = performance.now();
const listeners = (["SIGTERM", "SIGINT"] as const).map((signal) => {
  const listener = () => {
    if (!owned && Deno.env.get("COURSE_PERF_OWNED_GROUP") !== "1") {
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
  await Deno.writeTextFile(receipt + ".ready", JSON.stringify({ group }));
}
const status = await child.status;
const toolWallSeconds = (performance.now() - start) / 1000;
for (const { signal, listener } of listeners) {
  Deno.removeSignalListener(signal, listener);
}
await Deno.writeTextFile(
  receipt,
  JSON.stringify({ code: status.code, signal: status.signal, toolWallSeconds }),
);
Deno.exit(status.code);
