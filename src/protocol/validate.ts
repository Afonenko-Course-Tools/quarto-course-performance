import type { Event } from "./types.ts";
export function validateEvent(value: unknown): Event {
  if(!value || typeof value!=="object") throw new Error("Event должен быть объектом");
  const e=value as Event;
  if(e.schema_version!==1 || !Number.isInteger(e.sequence) || e.sequence<1) throw new Error("Некорректная версия или sequence");
  for(const key of ["experiment_id","run_id","process_id","executor_id"] as const) if(typeof e[key]!=="string" || !e[key]) throw new Error(`Отсутствует ${key}`);
  if(!["begin","end","counter","quality"].includes(e.event) || !["phase","function","ast_walk","io","command"].includes(e.kind) || !["manual","auto","runtime"].includes(e.origin) || !["monotonic_process","process_cpu","none"].includes(e.clock_domain)) throw new Error("Неизвестный Event или clock domain");
  if(e.event==="begin" || e.event==="end") {
    if(!e.span_id || !e.operation_id || !Number.isFinite(e.timestamp_us) || e.timestamp_us!<0 || e.clock_domain==="none") throw new Error("Некорректный span");
    if(e.event==="end" && !["ok","error","aborted"].includes(e.status!)) throw new Error("End без status");
  }
  if(e.event==="counter" && (!e.counter || typeof e.counter.name!=="string" || !Number.isFinite(e.counter.value) || e.counter.value<0 || !["observed-exact","partial"].includes(e.counter.quality))) throw new Error("Counter должен быть наблюдаемым приращением");
  return e;
}
