import type { RunRecord } from "../../src/report/types.ts";
export function record(directory: string, runId = "test"): RunRecord {
  return {
    schema_version: 2,
    runId,
    request: { cwd: "/course", quarto: "quarto", nativeArgv: [], mode: "off" },
    completion: {
      kind: "complete",
      native: {
        code: 7,
        signal: null,
        wallSeconds: 1,
        cpuUserSeconds: null,
        cpuSystemSeconds: null,
        peakRssKiB: null,
        wallScope: "direct-spawn-to-status",
        source: "direct-status",
        resourceScope: "unavailable",
      },
    },
    command: { code: 7, signal: null, wallSeconds: 1 },
    streams: { stdout: "eof", stderr: "eof" },
    stdioMode: "separate",
    observedWallSeconds: 1,
    preparedScripts: [],
    dataValid: true,
    quality: { droppedEvents: 0, incompleteSpans: 0, coverageComplete: false, errors: [] },
    versions: { tool: "2.0.0", quarto: "1.11.6", deno: null, pandoc: null },
    git: null,
    collectionDirectory: directory,
    artifacts: {},
  };
}
