import { array, number, object, oneOf, string, strings } from "../json.ts";
import type { Event } from "../protocol/types.ts";

export interface PackageCoverage {
  requested?: readonly string[];
  observationStatus: "pending" | "valid" | "partial";
  observations: {
    extensionId: string;
    attribution: "recorded" | "derived";
    processId: string;
    executorId: string;
    events: number;
  }[];
}

export function observePackages(
  selection: unknown,
  events: Event[],
  dataValid: boolean,
): PackageCoverage {
  const requested = selection && typeof selection === "object" && "requested" in selection
    ? requestedExtensions(selection.requested)
    : undefined;
  const result: PackageCoverage = {
    ...(requested ? { requested } : {}),
    observationStatus: "pending",
    observations: [],
  };
  const observations = new Map<string, PackageCoverage["observations"][number]>();
  for (const event of events) {
    const recorded = event.attributes?.extension_id;
    const extensionId = typeof recorded === "string" && recorded
      ? recorded
      : event.operation_id?.split(".")[0];
    if (!extensionId) continue;
    const attribution = typeof recorded === "string" && recorded ? "recorded" : "derived";
    const key = JSON.stringify([extensionId, attribution, event.process_id, event.executor_id]);
    const row = observations.get(key) ??
      {
        extensionId,
        attribution,
        processId: event.process_id,
        executorId: event.executor_id,
        events: 0,
      };
    row.events++;
    observations.set(key, row);
  }
  result.observations = [...observations.values()];
  result.observationStatus = dataValid ? "valid" : "partial";
  return result;
}

function requestedExtensions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const requested: string[] = [];
  for (const id of value) {
    if (typeof id !== "string") return undefined;
    requested.push(id);
  }
  return requested;
}

export function validatePackageCoverage(value: unknown): PackageCoverage | undefined {
  if (value === undefined) return undefined;
  const coverage = object(value, "packageCoverage");
  return {
    ...(coverage.requested === undefined ? {} : { requested: strings(coverage.requested) }),
    observationStatus: oneOf(coverage.observationStatus, ["pending", "valid", "partial"]),
    observations: array(coverage.observations).map((value) => {
      const observation = object(value, "package observation");
      const events = number(observation.events);
      if (!Number.isSafeInteger(events) || events < 0) {
        throw new Error("Некорректное число package events");
      }
      return {
        extensionId: string(observation.extensionId),
        attribution: oneOf(observation.attribution, ["recorded", "derived"]),
        processId: string(observation.processId),
        executorId: string(observation.executorId),
        events,
      };
    }),
  };
}
