import type { SimpleMode } from "../report/types.ts";

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "render"; mode: SimpleMode; outputParent?: string; nativeArgv: string[] }
  | { kind: "experiment"; argv: string[] };

export function parseCommand(argv: readonly string[]): Command {
  const [name, ...args] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "--version") {
    if (args.length) throw new Error("Лишние параметры команды справки/версии");
    return { kind: name === "--version" ? "version" : "help" };
  }
  if (name === "experiment") return { kind: "experiment", argv: args };
  if (name !== "render") throw new Error("Команды: render, experiment, --help, --version");
  let mode: SimpleMode = "off", outputParent: string | undefined;
  const seen = new Set<string>();
  let n = 0;
  while (n < args.length && args[n].startsWith("--perf-")) {
    const equal = args[n].indexOf("=");
    const flag = equal < 0 ? args[n] : args[n].slice(0, equal);
    if (flag !== "--perf-mode" && flag !== "--perf-output") {
      throw new Error(`Неизвестный параметр ${flag}`);
    }
    if (seen.has(flag)) throw new Error(`Повторный параметр ${flag}`);
    seen.add(flag);
    const value = equal < 0 ? args[++n] : args[n].slice(equal + 1);
    if (!value || value.startsWith("--")) throw new Error(`Необходимо значение ${flag}`);
    if (flag === "--perf-mode") {
      if (value === "trace") {
        throw new Error("Полный trace доступен в изолированном experiment run --mode trace");
      }
      if (value !== "off" && value !== "summary" && value !== "cpu") {
        throw new Error(`Неизвестный режим ${value}`);
      }
      mode = value;
    } else outputParent = value;
    n++;
  }
  // Один разделитель завершает только префикс оболочки; следующий принадлежит Quarto.
  if (args[n] === "--") n++;
  return {
    kind: "render",
    mode,
    ...(outputParent === undefined ? {} : { outputParent }),
    nativeArgv: args.slice(n),
  };
}
