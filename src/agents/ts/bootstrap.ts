import { oneOf } from "../../json.ts";
import { installTsAgent } from "./agent.ts";
const requested = Deno.env.get("COURSE_PERF_MODE");
const mode = requested
  ? oneOf(requested, ["off", "summary", "cpu", "trace"], "COURSE_PERF_MODE")
  : undefined;
if (mode && mode !== "off") {
  const registry = globalThis as Record<symbol, unknown>;
  if (!registry[Symbol.for("course.performance.agent.v1")]) {
    const agent = installTsAgent({
      experimentId: Deno.env.get("COURSE_PERF_EXPERIMENT_ID")!,
      runId: Deno.env.get("COURSE_PERF_RUN_ID")!,
      processId: Deno.env.get("COURSE_PERF_PROCESS_ID") ?? crypto.randomUUID(),
      outputDirectory: Deno.env.get("COURSE_PERF_OUTPUT_DIR")!,
      mode,
    });
    addEventListener("unload", () => agent.flush());
    // Fatal ошибки runtime не вызывают unload; штатная обработка ошибки сохраняется.
    addEventListener("error", () => agent.flush());
    addEventListener("unhandledrejection", () => agent.flush());
    const exit = Deno.exit;
    Deno.exit = (code?: number): never => {
      agent.flush();
      return exit(code);
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const handler = () => {
        agent.flush();
        Deno.removeSignalListener(signal, handler);
        Deno.kill(Deno.pid, signal);
      };
      Deno.addSignalListener(signal, handler);
    }
  }
}
