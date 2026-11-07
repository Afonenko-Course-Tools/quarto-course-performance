import type { Metrics } from "../../bridge/bridge.ts";

type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type AsyncInput = Parameters<Metrics["wrapAsync"]>[1];
type SyncCallbackMustBeRejected = Assert<
  (() => number) extends AsyncInput ? false : true
>;
type AsyncCallbackMustBeAccepted = Assert<
  (() => Promise<number>) extends AsyncInput ? true : false
>;
// Типовые контракты проверяются deno check; runtime-вызовов здесь нет.
export type WrapperContracts = [
  SyncCallbackMustBeRejected,
  AsyncCallbackMustBeAccepted,
  Assert<IsNever<Extract<AsyncInput, undefined>>>,
];

export function checkSignatures(metrics: Metrics): void {
  const generic = metrics.wrapSync({ id: "generic", kind: "function" }, <T>(value: T): T => value);
  const number: number = generic(42);
  const text: string = generic("typed");
  const sync = metrics.wrapSync(
    { id: "method", kind: "function" },
    function (this: { prefix: string }, first: string, ...rest: number[]): string {
      return this.prefix + first + rest.join();
    },
  );
  const result: string = sync.call({ prefix: "p" }, "x", 1, 2);
  const async = metrics.wrapAsync(
    { id: "async", kind: "function" },
    function (this: { value: number }, offset: number): Promise<number> {
      return Promise.resolve(this.value + offset);
    },
  );
  const promise: Promise<number> = async.call({ value: 1 }, 2);
  const walk = metrics.wrapWalk(
    { id: "walk", kind: "ast_walk", scope: "fragment" },
    (value: { text: string }): string => value.text,
  );
  const walked: string = walk({ text: "walked" });
  void [number, text, result, promise, walked];
}
