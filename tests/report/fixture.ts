import type { RunRecord } from "../../src/report/types.ts";
export function record(directory: string, runId = "test"): RunRecord {
  return {
    schema_version: 2,
    runId,
    request: { cwd: "/course", quarto: "quarto", nativeArgv: [], mode: "off" },
    outcome: {
      code: 7,
      signal: null,
      wallSeconds: 1,
      cpuUserSeconds: null,
      cpuSystemSeconds: null,
      peakRssKiB: null,
    },
    preparation: [],
    dataValid: true,
    quality: { droppedEvents: 0, incompleteSpans: 0, coverageComplete: false, errors: [] },
    versions: { tool: "2.0.0", quarto: "1.11.6", deno: null, pandoc: null },
    git: null,
    collectionDirectory: directory,
    outputDirectory: "/final/test",
    artifacts: {},
  };
}
