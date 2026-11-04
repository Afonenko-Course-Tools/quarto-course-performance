import type { Event } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertEvent(e: unknown): asserts e is Event {
  if (!isRecord(e)) throw new Error("Event должен быть объектом");
  if (
    e.schema_version !== 1 || typeof e.sequence !== "number" ||
    !Number.isInteger(e.sequence) || e.sequence < 1
  ) {
    throw new Error("Некорректная версия или sequence");
  }
  for (const key of ["experiment_id", "run_id", "process_id", "executor_id"] as const) {
    if (typeof e[key] !== "string" || !e[key]) throw new Error(`Отсутствует ${key}`);
  }
  if (
    e.event !== "begin" && e.event !== "end" && e.event !== "counter" && e.event !== "quality" ||
    e.kind !== "phase" && e.kind !== "function" && e.kind !== "ast_walk" && e.kind !== "io" &&
      e.kind !== "command" ||
    e.origin !== "manual" && e.origin !== "auto" && e.origin !== "runtime" ||
    e.clock_domain !== "monotonic_process" && e.clock_domain !== "process_cpu" &&
      e.clock_domain !== "none"
  ) throw new Error("Неизвестный Event или clock domain");
  for (const key of ["span_id", "parent_span_id", "operation_id", "symbol_id"] as const) {
    if (e[key] !== undefined && typeof e[key] !== "string") {
      throw new Error(`Некорректный ${key}`);
    }
  }
  if (e.document_id !== undefined && (typeof e.document_id !== "string" || !e.document_id)) {
    throw new Error("Некорректный document_id");
  }
  if (e.timestamp_us !== undefined && typeof e.timestamp_us !== "number") {
    throw new Error("Некорректный timestamp_us");
  }
  if (
    e.status !== undefined && e.status !== "ok" && e.status !== "error" && e.status !== "aborted"
  ) throw new Error("Некорректный status");
  if (
    e.attributes !== undefined &&
    (!isRecord(e.attributes) ||
      Object.values(e.attributes).some((value) =>
        value !== null && typeof value !== "string" && typeof value !== "boolean" &&
        !(typeof value === "number" && Number.isFinite(value))
      ))
  ) throw new Error("Некорректные attributes");
  if (e.event === "begin" || e.event === "end") {
    if (
      !e.span_id || !e.operation_id || typeof e.timestamp_us !== "number" ||
      !Number.isFinite(e.timestamp_us) || e.timestamp_us < 0 || e.clock_domain === "none"
    ) throw new Error("Некорректный span");
    if (e.event === "end" && e.status === undefined) {
      throw new Error("End без status");
    }
  }
  if (
    e.counter !== undefined &&
    (!isRecord(e.counter) || typeof e.counter.name !== "string" ||
      typeof e.counter.value !== "number" || !Number.isFinite(e.counter.value) ||
      e.counter.value < 0 ||
      e.counter.quality !== "observed-exact" && e.counter.quality !== "partial")
  ) throw new Error("Counter должен быть наблюдаемым приращением");
  if (e.event === "counter" && e.counter === undefined) {
    throw new Error("Counter должен быть наблюдаемым приращением");
  }
}

export function validateEvent(value: unknown): Event {
  assertEvent(value);
  return value;
}
