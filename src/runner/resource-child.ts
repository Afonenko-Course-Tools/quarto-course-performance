// Внешний помощник GNU time: сохраняет native child status без вывода в stdout/stderr.
// Не используется в Hyperfine benchmark и не устанавливается в owner packages.
const [receipt, executable, ...args] = Deno.args;
if (!receipt || !executable) throw new Error("Необходимы status receipt и executable");
const start = performance.now();
const child = new Deno.Command(executable, {
  args,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
const listeners = (["SIGTERM", "SIGINT"] as const).map((signal) => {
  const listener = () => {
    try {
      child.kill(signal);
    } catch { /* Процесс уже завершился. */ }
  };
  Deno.addSignalListener(signal, listener);
  return { signal, listener };
});
const status = await child.status;
const toolWallSeconds = (performance.now() - start) / 1000;
for (const { signal, listener } of listeners) Deno.removeSignalListener(signal, listener);
await Deno.writeTextFile(
  receipt,
  JSON.stringify({ code: status.code, signal: status.signal, toolWallSeconds }),
);
Deno.exit(status.code);
