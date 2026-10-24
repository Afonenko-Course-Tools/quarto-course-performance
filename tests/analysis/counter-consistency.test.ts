import { strict as assert } from "node:assert";
import { join } from "node:path";
import { normalizeRun } from "../../src/analysis/normalize.ts";
import { summarizeRunRecord } from "../../src/report/run.ts";
import { record } from "../report/fixture.ts";

for (const kind of ["match", "mismatch", "executors", "summary-only", "partial"]) {
  Deno.test(`counter delta/total reconciliation: ${kind}`, async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(root, "events"));
      for (const executor of kind === "executors" ? ["a", "b"] : ["a"]) {
        const total = executor === "b" ? 8 : 2;
        await Deno.writeTextFile(
          join(root, `events/${executor}.summary.json`),
          JSON.stringify({
            schema_version: 1,
            experiment_id: "e",
            run_id: "r",
            process_id: "p",
            executor_id: executor,
            clock_domain: "monotonic_process",
            data_valid: true,
            dropped_events: kind === "partial" ? 1 : 0,
            incomplete_spans: 0,
            counters: { calls: total },
            errors: [],
          }),
        );
        if (kind !== "summary-only") {
          const values = kind === "mismatch" || kind === "partial" ? [1] : [total / 2, total / 2];
          await Deno.writeTextFile(
            join(root, `events/${executor}.jsonl`),
            values.map((value, i) =>
              JSON.stringify({
                schema_version: 1,
                experiment_id: "e",
                run_id: "r",
                process_id: "p",
                executor_id: executor,
                sequence: i + 1,
                event: "counter",
                kind: "phase",
                origin: "manual",
                clock_domain: "none",
                counter: {
                  name: "calls",
                  value,
                  quality: kind === "partial" ? "partial" : "observed-exact",
                },
              })
            ).join("\n") + "\n",
          );
        }
      }
      const run = await normalizeRun(root);
      const mismatch = kind === "mismatch" || kind === "partial";
      assert.equal(run.dataValid, !mismatch);
      assert.equal(run.quality.errors.some((s) => /counter.*delta.*total/i.test(s)), mismatch);
      const summary = summarizeRunRecord({
        ...record(root, "r"),
        dataValid: run.dataValid,
        quality: run.quality,
      }, run);
      const observations = summary.counters.filter((c) => c.executorId === "a");
      assert.deepEqual(
        observations.map((c) => [c.source, c.value]),
        kind === "summary-only"
          ? [["executor-summary", 2]]
          : [["event", mismatch ? 1 : 2], ["executor-summary", 2]],
      );
      if (mismatch) assert(observations.every((c) => c.quality === "partial"));
      if (kind === "partial") assert.equal(run.quality.droppedEvents, 1);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
