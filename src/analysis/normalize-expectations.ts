import { join } from "node:path";
import { number, parseObject } from "../json.ts";
import { validateDiagnosticExpectations } from "../report/types.ts";
import type { NormalizeOptions, NormalizeState } from "./normalize-state.ts";
export async function validateNormalizeExpectations(
  directory: string,
  state: NormalizeState,
  options: NormalizeOptions,
) {
  if (state.expectations) {
    for (const receipt of state.started) {
      let expected = state.expectations.processes.find((p) =>
        p.process_id === receipt.process_id && p.agent === receipt.agent
      );
      if (!expected) {
        expected = {
          process_id: receipt.process_id,
          agent: receipt.agent,
          requested: true,
          supported: true,
          activated: true,
          executed: true,
        };
        state.expectations.processes.push(expected);
      }
      if (!expected.requested || !expected.supported) {
        state.quality.errors.push(
          `Started противоречит ожиданиям: ${receipt.process_id}/${receipt.agent}`,
        );
      } else {
        expected.activated = true;
        expected.executed = true;
        expected.summary_path ??= receipt.agent === "ts"
          ? `events/${receipt.process_id}/${receipt.executor_id}.summary.json`
          : `events/${receipt.process_id}/`;
      }
    }
    try {
      validateDiagnosticExpectations(state.expectations);
    } catch (e) {
      state.quality.errors.push(`Expectations: ${String(e)}`);
    }
    for (const expected of state.expectations.processes) {
      if (expected.summary_path) {
        const path = join(directory, expected.summary_path);
        const matches = [...state.summaryPaths].some(([file, summary]) =>
          (expected.summary_path!.endsWith("/")
            ? file.startsWith(path.endsWith("/") ? path : path + "/")
            : file === path) &&
          summary.process_id === expected.process_id &&
          summary.clock_domain === (expected.agent === "ts" ? "monotonic_process" : "process_cpu")
        );
        if (!matches) {
          state.quality.errors.push(
            `Отсутствует ожидаемый summary: ${expected.process_id} ${expected.summary_path}`,
          );
        }
      }
      if (expected.profile_path) {
        try {
          const profile = parseObject(
            await Deno.readTextFile(join(directory, expected.profile_path)),
          );
          if (
            !Array.isArray(profile.nodes) || !Number.isFinite(profile.startTime) ||
            !Number.isFinite(profile.endTime) || number(profile.endTime) < number(profile.startTime)
          ) throw new Error("Некорректный CPU profile");
        } catch (e) {
          state.quality.errors.push(`CPU ${expected.process_id}: ${String(e)}`);
        }
      }
    }
    for (const receipt of state.started) {
      const summary = state.summaryPaths.get(
        receipt.path.replace(/\.started\.json$/, ".summary.json"),
      );
      if (
        !summary || summary.process_id !== receipt.process_id ||
        summary.executor_id !== receipt.executor_id ||
        summary.clock_domain !== (receipt.agent === "ts" ? "monotonic_process" : "process_cpu")
      ) {
        state.quality.errors.push(
          `Отсутствует summary начавшегося executor: ${receipt.process_id}/${receipt.executor_id}`,
        );
      }
    }
    if (!options.readOnly) {
      await Deno.writeTextFile(
        join(directory, "expectations.json"),
        JSON.stringify(state.expectations, null, 2) + "\n",
      );
    }
  }
}
