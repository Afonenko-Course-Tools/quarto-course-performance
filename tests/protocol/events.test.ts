import { strict as assert } from "node:assert";
import { validateEvent } from "../../src/protocol/validate.ts";
const event = {
  schema_version: 1,
  experiment_id: "e",
  run_id: "r",
  process_id: "p",
  executor_id: "x",
  sequence: 1,
  event: "counter",
  kind: "ast_walk",
  origin: "manual",
  clock_domain: "none",
  counter: { name: "walk_api_calls", value: 1, quality: "observed-exact" },
};
Deno.test("counter is a delta; missing clock, negative or unobserved counts are rejected", () => {
  assert.equal(validateEvent(event).counter?.value, 1);
  for (
    const change of [
      { clock_domain: undefined },
      { counter: { ...event.counter, value: null } },
      { counter: { ...event.counter, value: -1 } },
      { sequence: 0 },
      { schema_version: 2 },
    ]
  ) assert.throws(() => validateEvent({ ...event, ...change }));
});
