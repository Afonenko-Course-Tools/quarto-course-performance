import type { Mode, PreparedScript } from "../config/types.ts";
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
  code: number;
  signal: Deno.Signal | null;
  wallSeconds: number;
  cpuUserSeconds: number | null;
  cpuSystemSeconds: number | null;
  peakRssKiB: number | null;
  wallScope:
    | "direct-spawn-to-status"
    | "resource-helper-envelope"
    | "hyperfine-command"
    | "historical";
  source: "direct-status" | "native-receipt" | "hyperfine" | "historical-record";
  resourceScope:
    | "tool-and-resource-helper"
    | "native-hyperfine-command"
    | "unavailable"
    | "historical";
}
export interface CommandResult {
  code: number;
  signal: Deno.Signal | null;
  wallSeconds: number;
}
export type StreamState = "not-started" | "open" | "eof" | "failed";
export interface ProcessObservation {
  native: BuildOutcome | null;
  command: CommandResult | null;
  /** Owned log channels; combined PTY stdout is not independent native stdout. */
  streams: { stdout: StreamState; stderr: StreamState };
  stdioMode: "separate" | "pty-combined" | null;
  errors: string[];
  observedWallSeconds: number;
}
export type RunCompletion =
  | { kind: "complete"; native: BuildOutcome }
  | {
    kind: "incomplete";
    reason: "not-finalized" | "interrupted" | "observation-error";
    requestedSignal: "SIGTERM" | "SIGINT" | null;
    native: BuildOutcome | null;
  };
export interface PublishedRun {
  record: RunRecord;
  directory: string;
}
export class PublicationError extends Error {
  constructor(
    readonly runId: string,
    readonly directory: string,
    readonly phase: "record" | "derived" | "storage",
    cause: unknown,
    readonly published?: PublishedRun,
    readonly attempted?: RunRecord,
  ) {
    super(`Не удалось сохранить ${phase} запуска ${runId}: ${directory}`, { cause });
    this.name = "PublicationError";
  }
}
export interface GitProvenance {
  root: string;
  head: string | null;
  dirty: boolean;
}
export interface ImportProvenance {
  schema_version: 1;
  adapterVersion: string;
  sourceDirectory: string;
  manifest: { path: string; schemaVersion: number | null };
  run: { path: string; schemaVersion: number | null };
  runManifest?: { path: string; schemaVersion: number | null };
  sourceStatus: { buildExitCode: number; dataValid: boolean | null; signalAvailability: string };
}
export interface RunRecord {
  importProvenance?: ImportProvenance;
  schema_version: 2;
  runId: string;
  request: RunRequest;
  completion: RunCompletion;
  command: CommandResult | null;
  streams: ProcessObservation["streams"];
  stdioMode: ProcessObservation["stdioMode"];
  observedWallSeconds: number;
  preparedScripts: PreparedScript[];
  dataValid: boolean;
  quality: QualitySummary;
  versions: { tool: string; quarto: string; deno: string | null; pandoc: string | null };
  git: GitProvenance | null;
  collectionDirectory: string;
  artifacts: Record<string, string>;
  scenario?: string;
  variant?: string;
  mode?: Mode;
  argv?: string[];
  cwd?: string;
  cachePolicy?: string;
  experimentId?: string;
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
export interface NativeCommandTiming {
  wall_seconds: number | null;
  clock_domain: "monotonic_process";
  scope: "launcher-spawn-to-status";
}
export interface ProcessReceipt {
  process_id: string;
  parent_process_id: string | null;
  parent_link: "confirmed" | "unlinked";
  kind: "deno" | "pandoc";
  os_pid: number | null;
  argv: string[];
  cwd: string;
  exit_code: number | null;
  signal: Deno.Signal | null;
  expectation?: ProcessExpectation;
  native_command?: NativeCommandTiming;
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
  importProvenance?: ImportProvenance;
  schema_version: 2;
  runId: string;
  completion: RunCompletion["kind"];
  normalization: "available" | "not-processed";
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

/** Consumed fields of the existing resource-child status file, not a new receipt. */
export function readNativeStatus(value: unknown): {
  code: number;
  signal: Deno.Signal | null;
  toolWallSeconds: number;
} {
  const v = object(value, "native status");
  if (typeof v.code !== "number" || !Number.isSafeInteger(v.code) || v.code < 0) {
    invalid("native status.code");
  }
  if (
    typeof v.toolWallSeconds !== "number" || !Number.isFinite(v.toolWallSeconds) ||
    v.toolWallSeconds < 0
  ) invalid("native status.wall");
  const signal = signals.find((signal) => signal === v.signal);
  if (v.signal !== null && signal === undefined) invalid("native status.signal");
  return { code: v.code, signal: signal ?? null, toolWallSeconds: v.toolWallSeconds };
}

export function validateRunRecord(value: unknown): RunRecord {
  const r = metadata(value), request = object(r.request, "request");
  string(request.cwd, "request.cwd");
  string(request.quarto, "request.quarto");
  strings(request.nativeArgv, "request.nativeArgv");
  if (!["off", "summary", "cpu", "trace"].includes(request.mode as string)) invalid("request.mode");
  if (request.outputParent !== undefined) string(request.outputParent, "request.outputParent");
  const completion = object(r.completion, "completion");
  if (completion.kind !== "complete" && completion.kind !== "incomplete") {
    invalid("completion.kind");
  }
  if (completion.kind === "incomplete") {
    if (
      typeof completion.reason !== "string" ||
      !["not-finalized", "interrupted", "observation-error"].includes(completion.reason)
    ) invalid("completion.reason");
    if (
      completion.requestedSignal !== null && completion.requestedSignal !== "SIGINT" &&
      completion.requestedSignal !== "SIGTERM"
    ) invalid("completion.requestedSignal");
    if (r.dataValid !== false || object(r.quality, "quality").coverageComplete !== false) {
      invalid("incomplete.quality");
    }
  }
  if (completion.native !== null) {
    const outcome = object(completion.native, "completion.native");
    number(outcome.code, "native.code", false, true);
    if (outcome.signal !== null && !signals.includes(outcome.signal as Deno.Signal)) {
      invalid("native.signal");
    }
    number(outcome.wallSeconds, "native.wallSeconds");
    if (outcome.escalated !== undefined) boolean(outcome.escalated, "native.escalated");
    for (const field of ["cpuUserSeconds", "cpuSystemSeconds", "peakRssKiB"]) {
      number(outcome[field], `native.${field}`, true);
    }
    if (
      typeof outcome.wallScope !== "string" ||
      !["direct-spawn-to-status", "resource-helper-envelope", "hyperfine-command", "historical"]
        .includes(outcome.wallScope)
    ) invalid("native.wallScope");
    if (
      typeof outcome.source !== "string" ||
      !["direct-status", "native-receipt", "hyperfine", "historical-record"].includes(
        outcome.source,
      )
    ) invalid("native.source");
    if (
      typeof outcome.resourceScope !== "string" ||
      !["tool-and-resource-helper", "native-hyperfine-command", "unavailable", "historical"]
        .includes(outcome.resourceScope)
    ) invalid("native.resourceScope");
  } else if (completion.kind === "complete") invalid("complete.native");
  if (r.command !== null) {
    const command = object(r.command, "command");
    number(command.code, "command.code", false, true);
    number(command.wallSeconds, "command.wallSeconds");
    if (command.signal !== null && !signals.includes(command.signal as Deno.Signal)) {
      invalid("command.signal");
    }
  }
  const streams = object(r.streams, "streams");
  if (r.stdioMode !== null && r.stdioMode !== "separate" && r.stdioMode !== "pty-combined") {
    invalid("stdioMode");
  }
  for (const name of ["stdout", "stderr"]) {
    if (
      typeof streams[name] !== "string" ||
      !["not-started", "open", "eof", "failed"].includes(streams[name])
    ) invalid(`streams.${name}`);
    if (completion.kind === "complete" && streams[name] !== "eof") {
      invalid(`complete.streams.${name}`);
    }
  }
  number(r.observedWallSeconds, "observedWallSeconds");
  if (!Array.isArray(r.preparedScripts)) invalid("preparedScripts");
  for (const receipt of r.preparedScripts) {
    const p = object(receipt, "preparedScripts");
    if (!["bootstrap", "ts-transform", "quarto-adapter"].includes(p.kind as string)) {
      invalid("preparedScripts.kind");
    }
    if (Object.keys(p).some((key) => !["kind", "path", "sourceMapPath"].includes(key))) {
      invalid("preparedScripts.fields");
    }
    string(p.path, "preparedScripts.path");
    if (p.sourceMapPath !== undefined) string(p.sourceMapPath, "preparedScripts.sourceMapPath");
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
  for (const field of ["scenario", "variant", "cwd", "cachePolicy", "experimentId"]) {
    if (r[field] !== undefined) string(r[field], field);
  }
  if (r.argv !== undefined) strings(r.argv, "argv");
  if (
    r.mode !== undefined && r.mode !== "off" && r.mode !== "summary" && r.mode !== "cpu" &&
    r.mode !== "trace"
  ) invalid("mode");
  const artifacts = object(r.artifacts, "artifacts");
  for (const [name, path] of Object.entries(artifacts)) string(path, `artifacts.${name}`);
  return r as unknown as RunRecord;
}

export function validateRunSummary(value: unknown): RunSummary {
  const s = metadata(value);
  if (s.completion !== "complete" && s.completion !== "incomplete") invalid("summary.completion");
  if (s.normalization !== "available" && s.normalization !== "not-processed") {
    invalid("summary.normalization");
  }
  if (
    s.completion === "incomplete" &&
    (s.dataValid !== false || object(s.quality, "quality").coverageComplete !== false)
  ) invalid("incomplete.summary");
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

/** Incomplete captures never enter benchmarks, acceptance or comparison. */
export function completedNative(publication: PublishedRun): BuildOutcome {
  if (publication.record.completion.kind !== "complete") {
    throw new Error(`Неполный запуск: ${publication.directory}`);
  }
  return publication.record.completion.native;
}
