import type { Event } from "../protocol/types.ts";
import type { DiagnosticExpectations } from "../report/types.ts";
import type { QualitySummary } from "./normalize.ts";
export interface NormalizeOptions {
  readOnly?: boolean;
  identity?: { runId: string; experimentId: string };
}
export interface StartedReceipt {
  path: string;
  process_id: string;
  executor_id: string;
  agent: "ts" | "lua";
}
export interface NormalizeState {
  runId: string;
  experimentId: string;
  events: Event[];
  quality: QualitySummary;
  executors: Record<string, Record<string, unknown>>;
  expectations: DiagnosticExpectations | undefined;
  processes: Record<string, unknown>[];
  summaries: number;
  summaryPaths: Map<string, Record<string, unknown>>;
  started: StartedReceipt[];
}
export function createNormalizeState(options: NormalizeOptions): NormalizeState {
  return {
    runId: options.identity?.runId ?? "",
    experimentId: options.identity?.experimentId ?? "",
    events: [],
    quality: { droppedEvents: 0, incompleteSpans: 0, coverageComplete: false, errors: [] },
    executors: {},
    expectations: undefined,
    processes: [],
    summaries: 0,
    summaryPaths: new Map(),
    started: [],
  };
}
