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

Deno.test("raw Event rejects metadata versions and never infers an absent version", () => {
  for (const schema_version of [undefined, null, "1", 2, 3]) {
    assert.throws(() => validateEvent({ ...event, schema_version }));
  }
  assert.equal(validateEvent(event).schema_version, 1);
});

Deno.test("optional ABI 1 context preserves primitive attributes and rejects invalid context", () => {
  const recorded = validateEvent({
    ...event,
    document_id: "doc.qmd",
    attributes: { extension_id: "owner", n: 1, b: true, nil: null },
  });
  assert.equal(recorded.document_id, "doc.qmd");
  assert.equal(recorded.schema_version, 1);
  for (
    const patch of [{ document_id: 7 }, { document_id: "" }, { attributes: [] }, {
      attributes: { bad: {} },
    }, { attributes: { bad: NaN } }]
  ) assert.throws(() => validateEvent({ ...event, ...patch }));
});

Deno.test("Event boundary rejects non-string span identities before normalization", () => {
  const begin = {
    ...event,
    event: "begin",
    clock_domain: "monotonic_process",
    span_id: "s",
    operation_id: "op",
    timestamp_us: 0,
  };
  assert.equal(validateEvent(begin), begin);
  assert.equal(validateEvent({ ...begin, event: "end", status: "ok" }).status, "ok");
  for (const key of ["span_id", "parent_span_id", "operation_id", "symbol_id"]) {
    assert.throws(() => validateEvent({ ...begin, [key]: 7 }), /Некорректный/);
    assert.throws(() => validateEvent({ ...event, [key]: {} }), /Некорректный/);
  }
  const extended = {
    ...event,
    span_id: "",
    parent_span_id: "",
    operation_id: "",
    symbol_id: "",
    future_context: { owner: "extension" },
  };
  assert.equal(validateEvent(extended), extended);
  assert.equal(extended.future_context.owner, "extension");
});

Deno.test("optional Event payloads are typed even outside their usual event kind", () => {
  const quality = { ...event, event: "quality", counter: undefined };
  assert.equal(validateEvent(quality), quality);
  assert.equal(validateEvent({ ...quality, counter: event.counter }).counter?.value, 1);
  for (
    const patch of [
      { timestamp_us: "0" },
      { status: "pending" },
      { counter: null },
      { counter: { ...event.counter, name: 7 } },
      { counter: { ...event.counter, value: "1" } },
      { counter: { ...event.counter, quality: "estimated" } },
    ]
  ) assert.throws(() => validateEvent({ ...quality, ...patch }));
});
