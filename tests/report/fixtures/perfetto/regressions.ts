import { pair, run } from "./control.ts";

// Контрольные регрессии независимого ревью; не измерения курса.
export function regressionRuns() {
  const equalStart = run([
    ...pair("parent", 0, 20),
    ...pair("child", 0, 10, { parent_span_id: "parent" }),
  ]);
  const equalBounds = run([
    ...pair("parent", 0, 20),
    ...pair("child", 0, 20, { parent_span_id: "parent" }),
  ]);
  const mixedClocks = run([
    ...pair("wall", 0, 10),
    ...pair("cpu", 1, 9, { clock_domain: "process_cpu" }),
  ]);
  mixedClocks.executors[`${mixedClocks.events[0].process_id}/ts`].calibration = {
    time_origin_ms: 0,
  };
  mixedClocks.dataValid = false;
  mixedClocks.quality.errors.push("Несовпадение часов executor summary");
  const cycle = run([
    ...pair("a", 0, 20, { parent_span_id: "b" }),
    ...pair("b", 5, 10, { parent_span_id: "a" }),
  ]);
  const leadingCycle = run([...cycle.events, ...pair("c", 6, 9, { parent_span_id: "b" })]);
  for (const input of [cycle, leadingCycle]) {
    input.dataValid = false;
    input.quality.errors.push("Цикл parent spans: a");
  }
  const lua = { clock_domain: "process_cpu" as const, executor_id: "lua" };
  const localCpu = run([
    ...pair("parent", 0, 10, lua),
    ...pair("child", 30, 40, { ...lua, parent_span_id: "parent" }),
  ]);
  const localWall = run([
    ...pair("parent", 0, 10),
    ...pair("child", 30, 40, { parent_span_id: "parent" }),
  ]);
  localWall.executors[`${localWall.events[0].process_id}/ts`].calibration = undefined;
  return { equalStart, equalBounds, mixedClocks, cycle, leadingCycle, localCpu, localWall };
}
