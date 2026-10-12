export type {Metrics,OperationSpec,WalkSpec} from "../../bridge/bridge.ts";
export interface Event {
  schema_version: 1; experiment_id:string; run_id:string; process_id:string; executor_id:string; sequence:number;
  event:"begin"|"end"|"counter"|"quality"; kind:"phase"|"function"|"ast_walk"|"io"|"command";
  span_id?:string; parent_span_id?:string; operation_id?:string; symbol_id?:string; document_id?:string;
  origin:"manual"|"auto"|"runtime"; clock_domain:"monotonic_process"|"process_cpu"|"none";
  timestamp_us?:number; status?:"ok"|"error"|"aborted";
  counter?: {name:string;value:number;quality:"observed-exact"|"partial"};
  attributes?:Record<string,string|number|boolean|null>;
}
