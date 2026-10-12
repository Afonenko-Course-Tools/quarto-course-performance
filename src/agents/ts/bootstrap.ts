import { installTsAgent } from "./agent.ts";
import type { Mode } from "../../config/types.ts";
const mode = Deno.env.get("COURSE_PERF_MODE") as Mode | undefined;
if (mode && mode !== "off") {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  if (!registry[Symbol.for("course.performance.agent.v1")]) {
    const agent = installTsAgent({
      experimentId: Deno.env.get("COURSE_PERF_EXPERIMENT_ID")!,
      runId: Deno.env.get("COURSE_PERF_RUN_ID")!,
      processId: Deno.env.get("COURSE_PERF_PROCESS_ID") ?? crypto.randomUUID(),
      outputDirectory: Deno.env.get("COURSE_PERF_OUTPUT_DIR")!,
      mode,
    });
    addEventListener("unload", () => agent.flush());
    const exit = Deno.exit;
    Deno.exit = ((code?: number): never => {
      agent.flush();
      return exit(code);
    }) as typeof Deno.exit;
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
