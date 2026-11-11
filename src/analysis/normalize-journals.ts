import { join } from "node:path";
import { object, parseObject, string, strings } from "../json.ts";
import { validateEvent } from "../protocol/validate.ts";
import { validateDiagnosticExpectations } from "../report/types.ts";
import { files } from "../sources/files.ts";
import type { NormalizeOptions, NormalizeState } from "./normalize-state.ts";
export async function readNormalizeIdentity(
  directory: string,
  state: NormalizeState,
  options: NormalizeOptions,
) {
  try {
    const identity = parseObject(await Deno.readTextFile(join(directory, "mode.json")));
    if (
      options.identity &&
      (identity.runId !== state.runId || identity.experimentId !== state.experimentId)
    ) {
      state.quality.errors.push("Mode receipt расходится с identity metadata");
    } else {
      state.runId = identity.runId === undefined ? state.runId : string(identity.runId);
      state.experimentId = identity.experimentId === undefined
        ? state.experimentId
        : string(identity.experimentId);
    }
  } catch { /* Старые fixture не имеют receipt. */ }
  try {
    state.expectations = validateDiagnosticExpectations(
      parseObject(await Deno.readTextFile(join(directory, "expectations.json"))),
    );
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      state.quality.errors.push(`Expectations: ${String(e)}`);
    }
  }
  try {
    for await (const entry of Deno.readDir(join(directory, "processes"))) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const process = parseObject(
        await Deno.readTextFile(join(directory, "processes", entry.name)),
      );
      state.processes.push(process);
      if (process.expectation) {
        const receipt = validateDiagnosticExpectations({
          schema_version: 2,
          processes: [process.expectation],
        });
        const expected = receipt.processes[0];
        if (!expected) throw new Error("Нет ожидаемого process receipt");
        state.expectations ??= { schema_version: 2, processes: [] };
        const old = state.expectations.processes.findIndex((p) =>
          p.process_id === expected.process_id && p.agent === expected.agent
        );
        if (old >= 0) state.expectations.processes[old] = expected;
        else state.expectations.processes.push(expected);
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) state.quality.errors.push(`Processes: ${String(e)}`);
  }
}
export async function readStarted(path: string, state: NormalizeState) {
  try {
    const receipt = parseObject(await Deno.readTextFile(path));
    if (
      receipt.schema_version !== 1 || typeof receipt.process_id !== "string" ||
      !receipt.process_id || typeof receipt.executor_id !== "string" || !receipt.executor_id ||
      receipt.agent !== "ts" && receipt.agent !== "lua" || receipt.executed !== true
    ) throw new Error("Некорректный executor started receipt");
    state.started.push({
      path,
      process_id: receipt.process_id,
      executor_id: receipt.executor_id,
      agent: receipt.agent,
    });
  } catch (e) {
    state.quality.errors.push(`Started ${path}: ${String(e)}`);
  }
}
export async function readSummary(path: string, state: NormalizeState) {
  try {
    const s = parseObject(await Deno.readTextFile(path));
    if (
      s.schema_version !== 1 || typeof s.run_id !== "string" || !s.run_id ||
      typeof s.experiment_id !== "string" || !s.experiment_id ||
      typeof s.process_id !== "string" || !s.process_id ||
      typeof s.executor_id !== "string" || !s.executor_id ||
      !["monotonic_process", "process_cpu"].includes(string(s.clock_domain)) ||
      typeof s.dropped_events !== "number" || !Number.isSafeInteger(s.dropped_events) ||
      s.dropped_events < 0 ||
      typeof s.incomplete_spans !== "number" || !Number.isSafeInteger(s.incomplete_spans) ||
      s.incomplete_spans < 0 ||
      !s.counters || Object.values(object(s.counters)).some((n) =>
        typeof n !== "number" || !Number.isFinite(n) || n < 0
      )
    ) {
      throw new Error("Некорректный schema/counters/quality summary");
    }
    if (
      state.runId && s.run_id !== state.runId ||
      state.experimentId && s.experiment_id !== state.experimentId
    ) {
      throw new Error("Смешаны run/experiment summary");
    }
    state.runId = s.run_id;
    state.experimentId = s.experiment_id;
    if (state.executors[`${s.process_id}/${s.executor_id}`]) {
      throw new Error("Повтор executor summary");
    }
    state.summaries++;
    state.summaryPaths.set(path, s);
    state.quality.droppedEvents += s.dropped_events ?? 0;
    state.quality.incompleteSpans += s.incomplete_spans ?? 0;
    state.quality.errors.push(
      ...s.errors === undefined ? [] : strings(s.errors),
      ...s.abi_failures === undefined ? [] : strings(s.abi_failures),
    );
    if (!s.data_valid) {
      state.quality.errors.push(`Невалидный executor ${path}`);
    }
    state.executors[`${s.process_id}/${s.executor_id}`] = s;
  } catch (e) {
    state.quality.errors.push(`Summary ${path}: ${String(e)}`);
  }
}
export async function readEvents(path: string, state: NormalizeState) {
  for (const line of (await Deno.readTextFile(path)).split("\n").filter(Boolean)) {
    try {
      const e = validateEvent(parseObject(line));
      state.events.push(e);
      if (state.runId && e.run_id !== state.runId) throw new Error("Смешаны run_id");
      if (state.experimentId && e.experiment_id !== state.experimentId) {
        throw new Error("Смешаны experiment_id");
      }
      state.runId = e.run_id;
      state.experimentId = e.experiment_id;
    } catch (e) {
      state.quality.errors.push(`Event ${path}: ${String(e)}`);
    }
  }
}
export async function readNormalizeJournals(directory: string, state: NormalizeState) {
  let entries: string[] = [];
  try {
    entries = await files(join(directory, "events"));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound) || !state.expectations) {
      state.quality.errors.push(`Журналы отсутствуют: ${String(e)}`);
    }
  }
  for (const path of entries) {
    if (path.endsWith(".started.json")) await readStarted(path, state);
    else if (path.endsWith(".summary.json")) await readSummary(path, state);
    else if (path.endsWith(".jsonl")) await readEvents(path, state);
  }
}
