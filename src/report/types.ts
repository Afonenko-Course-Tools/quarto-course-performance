import type { Mode, PreparationReceipt } from "../config/types.ts";
import type { QualitySummary } from "../analysis/normalize.ts";

export type SimpleMode = "off" | "summary" | "cpu";
export interface NativeRenderRequest {
  cwd: string;
  quarto: string;
  nativeArgv: string[];
  mode: SimpleMode;
  outputParent?: string;
}
export type RunRequest = Omit<NativeRenderRequest, "mode"> & { mode: Mode };

export interface BuildOutcome {
  escalated?: boolean;
  stdioMode?: "separate" | "pty-combined";
  code: number;
  signal: Deno.Signal | null;
  wallSeconds: number;
  cpuUserSeconds: number | null;
  cpuSystemSeconds: number | null;
  peakRssKiB: number | null;
}
export interface GitProvenance {
  root: string;
  head: string | null;
  dirty: boolean;
}
export interface RunRecord {
  schema_version: 2;
  runId: string;
  request: RunRequest;
  outcome: BuildOutcome;
  preparation: PreparationReceipt[];
  dataValid: boolean;
  quality: QualitySummary;
  versions: { tool: string; quarto: string; deno: string | null; pandoc: string | null };
  git: GitProvenance | null;
  collectionDirectory: string;
  outputDirectory: string;
  artifacts: Record<string, string>;
}
export interface CounterAggregate {
  processId: string;
  executorId: string;
  name: string;
  value: number;
  source: "event" | "executor-summary";
  semantics: "delta" | "total";
  quality: "observed-exact" | "partial";
}
export interface ProcessExpectation {
  process_id: string;
  agent: "ts" | "lua";
  requested: boolean;
  supported: boolean;
  activated: boolean;
  executed: boolean;
  summary_path?: string;
  profile_path?: string;
}
export interface DiagnosticExpectations {
  schema_version: 2;
  processes: ProcessExpectation[];
}
export interface OperationAggregate {
  extensionId?: string | null;
  extensionAttribution?: "recorded" | "derived" | "unavailable";
  operationId: string;
  clockDomain: "monotonic_process" | "process_cpu";
  completed: number;
  errors: number;
  inclusiveMicroseconds: number;
  selfMicroseconds: number | null;
  quality: "observed-exact" | "partial";
}
export interface RunSummary {
  schema_version: 2;
  runId: string;
  dataValid: boolean;
  quality: QualitySummary;
  operations: OperationAggregate[];
  counters: CounterAggregate[];
}

function invalid(field: string): never {
  throw new Error(`Некорректное поле metadata: ${field}`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string): void {
  if (typeof value !== "string" || !value) invalid(field);
}
function number(value: unknown, field: string, nullable = false, integer = false): void {
  if (nullable && value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(field);
  if (integer && !Number.isSafeInteger(value)) invalid(field);
}
function boolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") invalid(field);
}
function strings(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string")) invalid(field);
}
function quality(value: unknown): void {
  const q = object(value, "quality");
  number(q.droppedEvents, "quality.droppedEvents", false, true);
  number(q.incompleteSpans, "quality.incompleteSpans", false, true);
  boolean(q.coverageComplete, "quality.coverageComplete");
  strings(q.errors, "quality.errors");
}
function metadata(value: unknown): Record<string, unknown> {
  const m = object(value, "metadata");
  if (m.schema_version !== 2) invalid("schema_version: ожидается 2; legacy требует явного импорта");
  string(m.runId, "runId");
  boolean(m.dataValid, "dataValid");
  quality(m.quality);
  return m;
}
const signals: readonly Deno.Signal[] = [
  "SIGABRT",
  "SIGALRM",
  "SIGBREAK",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGEMT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINFO",
  "SIGINT",
  "SIGIO",
  "SIGPOLL",
  "SIGUNUSED",
  "SIGKILL",
  "SIGPIPE",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTKFLT",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
];

export function validateRunRecord(value: unknown): RunRecord {
  const r = metadata(value), request = object(r.request, "request");
  string(request.cwd, "request.cwd");
  string(request.quarto, "request.quarto");
  strings(request.nativeArgv, "request.nativeArgv");
  if (!["off", "summary", "cpu", "trace"].includes(request.mode as string)) invalid("request.mode");
  if (request.outputParent !== undefined) string(request.outputParent, "request.outputParent");
  const outcome = object(r.outcome, "outcome");
  number(outcome.code, "outcome.code", false, true);
  if (outcome.escalated !== undefined) boolean(outcome.escalated, "outcome.escalated");
  if (
    outcome.stdioMode !== undefined &&
    !["separate", "pty-combined"].includes(outcome.stdioMode as string)
  ) invalid("outcome.stdioMode");
  if (outcome.signal !== null && !signals.includes(outcome.signal as Deno.Signal)) {
    invalid("outcome.signal");
  }
  number(outcome.wallSeconds, "outcome.wallSeconds");
  number(outcome.cpuUserSeconds, "outcome.cpuUserSeconds", true);
  number(outcome.cpuSystemSeconds, "outcome.cpuSystemSeconds", true);
  number(outcome.peakRssKiB, "outcome.peakRssKiB", true);
  if (!Array.isArray(r.preparation)) invalid("preparation");
  for (const receipt of r.preparation) {
    const p = object(receipt, "preparation");
    if (!["bootstrap", "ts-transform", "quarto-adapter"].includes(p.kind as string)) {
      invalid("preparation.kind");
    }
    for (const field of ["path", "sourceHash", "preparedHash"]) {
      string(p[field], `preparation.${field}`);
    }
    if (p.sourceMapPath !== undefined) string(p.sourceMapPath, "preparation.sourceMapPath");
  }
  const versions = object(r.versions, "versions");
  for (const field of ["tool", "quarto"]) string(versions[field], `versions.${field}`);
  for (const field of ["deno", "pandoc"]) {
    if (versions[field] !== null) string(versions[field], `versions.${field}`);
  }
  if (r.git !== null) {
    const git = object(r.git, "git");
    string(git.root, "git.root");
    if (git.head !== null && (typeof git.head !== "string" || !/^[a-f0-9]{40}$/.test(git.head))) {
      invalid("git.head");
    }
    boolean(git.dirty, "git.dirty");
  }
  string(r.collectionDirectory, "collectionDirectory");
  string(r.outputDirectory, "outputDirectory");
  const artifacts = object(r.artifacts, "artifacts");
  for (const [name, path] of Object.entries(artifacts)) string(path, `artifacts.${name}`);
  return r as unknown as RunRecord;
}

export function validateRunSummary(value: unknown): RunSummary {
  const s = metadata(value);
  if (!Array.isArray(s.counters)) invalid("counters");
  for (const counter of s.counters) {
    const c = object(counter, "counters");
    for (const field of ["processId", "executorId", "name"]) string(c[field], `counters.${field}`);
    number(c.value, "counters.value");
    if (!["event", "executor-summary"].includes(c.source as string)) invalid("counters.source");
    if (!["delta", "total"].includes(c.semantics as string)) invalid("counters.semantics");
    if (!["observed-exact", "partial"].includes(c.quality as string)) invalid("counters.quality");
  }
  if (!Array.isArray(s.operations)) invalid("operations");
  for (const operation of s.operations) {
    const o = object(operation, "operations");
    string(o.operationId, "operations.operationId");
    if (!["monotonic_process", "process_cpu"].includes(o.clockDomain as string)) {
      invalid("operations.clockDomain");
    }
    number(o.completed, "operations.completed", false, true);
    number(o.errors, "operations.errors", false, true);
    number(o.inclusiveMicroseconds, "operations.inclusiveMicroseconds");
    number(o.selfMicroseconds, "operations.selfMicroseconds", true);
    if (!["observed-exact", "partial"].includes(o.quality as string)) invalid("operations.quality");
  }
  return s as unknown as RunSummary;
}

export function validateDiagnosticExpectations(value: unknown): DiagnosticExpectations {
  const e = object(value, "expectations");
  if (e.schema_version !== 2 || !Array.isArray(e.processes)) {
    invalid("expectations.schema_version/processes");
  }
  const seen = new Set<string>();
  for (const item of e.processes) {
    const p = object(item, "expectations.processes");
    string(p.process_id, "process_id");
    if (!["ts", "lua"].includes(p.agent as string)) invalid("agent");
    const key = `${p.process_id}/${p.agent}`;
    if (seen.has(key)) invalid("duplicate process expectation");
    seen.add(key);
    for (const field of ["requested", "supported", "activated", "executed"]) {
      boolean(p[field], field);
    }
    if (p.activated && (!p.requested || !p.supported) || p.executed && !p.activated) {
      invalid("activation");
    }
    for (const field of ["summary_path", "profile_path"]) {
      if (p[field] === undefined) continue;
      string(p[field], field);
      const path = p[field] as string;
      if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
        invalid(field);
      }
      if (field === "summary_path" && ((p.agent === "lua") !== path.endsWith("/"))) {
        invalid(`${field}/namespace`);
      }
      if (field === "profile_path" && (p.agent !== "ts" || path.endsWith("/"))) {
        invalid(`${field}/profile`);
      }
      if (!p.activated) invalid(`${field}/activation`);
    }
  }
  return e as unknown as DiagnosticExpectations;
}
