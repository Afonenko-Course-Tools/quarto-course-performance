import { number, object, oneOf, string } from "../json.ts";
import type { Event } from "./types.ts";

function assertEvent(value: unknown): asserts value is Event {
  const e = object(value, "Event");
  if (e.schema_version !== 1 || !Number.isInteger(e.sequence) || number(e.sequence) < 1) {
    throw new Error("Некорректная версия или sequence");
  }
  for (const key of ["experiment_id", "run_id", "process_id", "executor_id"] as const) {
    if (typeof e[key] !== "string" || !e[key]) throw new Error(`Отсутствует ${key}`);
  }
  oneOf(e.event, ["begin", "end", "counter", "quality"], "event");
  oneOf(e.kind, ["phase", "function", "ast_walk", "io", "command"], "kind");
  oneOf(e.origin, ["manual", "auto", "runtime"], "origin");
  oneOf(e.clock_domain, ["monotonic_process", "process_cpu", "none"], "clock_domain");
  for (const key of ["span_id", "parent_span_id", "operation_id", "symbol_id"] as const) {
    if (key in e) string(e[key], key);
  }
  if ("document_id" in e && (typeof e.document_id !== "string" || !e.document_id)) {
    throw new Error("Некорректный document_id");
  }
  if ("attributes" in e) {
    for (const value of Object.values(object(e.attributes, "attributes"))) {
      if (value !== null && typeof value !== "string" && typeof value !== "boolean") {
        number(value, "attributes");
      }
    }
  }
  if ("timestamp_us" in e) number(e.timestamp_us, "timestamp_us");
  if ("status" in e) oneOf(e.status, ["ok", "error", "aborted"], "status");
  if (e.event === "begin" || e.event === "end") {
    if (
      typeof e.span_id !== "string" || !e.span_id ||
      typeof e.operation_id !== "string" || !e.operation_id ||
      typeof e.timestamp_us !== "number" || e.timestamp_us < 0 || e.clock_domain === "none"
    ) throw new Error("Некорректный span");
    if (e.event === "end" && e.status === undefined) throw new Error("End без status");
  }
  if (e.event === "counter" || "counter" in e) {
    const counter = object(e.counter, "counter");
    string(counter.name, "counter.name");
    if (number(counter.value, "counter.value") < 0) {
      throw new Error("Counter должен быть наблюдаемым приращением");
    }
    oneOf(counter.quality, ["observed-exact", "partial"], "counter.quality");
  }
}
export function validateEvent(value: unknown): Event {
  assertEvent(value);
  return value;
}
