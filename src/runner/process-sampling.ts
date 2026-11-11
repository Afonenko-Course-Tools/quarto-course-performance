import { number, parseObject } from "../json.ts";
import { type BuildOutcome, validateSignal } from "../report/types.ts";

/** Статус wrapper не доказывает запуск и успешное завершение нативной команды. */
export async function collectProcessOutcome(
  measurement: {
    receipt: string;
    time: string | null;
    status: Deno.CommandStatus;
    start: number;
    escalated: boolean;
    cancelled: boolean;
    stdioMode: "separate" | "pty-combined";
  },
  failed: (error: unknown) => void,
) {
  const { receipt, time, status, start, escalated, cancelled, stdioMode } = measurement;
  const resources = receipt + ".resources";
  let nativeStarted = false;
  let nativeStatus: { code: number; signal: Deno.Signal | null } = status;
  let nativeReceipt = false;
  for (const path of [receipt, ...(time ? [receipt + ".native"] : [])]) {
    try {
      const receipt = parseObject(await Deno.readTextFile(path));
      nativeStatus = { code: number(receipt.code), signal: validateSignal(receipt.signal) };
      if (path.endsWith(".native") || !time) nativeReceipt = true;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) failed(e);
    }
  }
  if (escalated && !nativeReceipt) {
    nativeStatus = { code: 137, signal: "SIGKILL" };
  }
  let cpuUserSeconds: number | null = null,
    cpuSystemSeconds: number | null = null,
    peakRssKiB: number | null = null;
  if (time) {
    try {
      const values = (await Deno.readTextFile(resources)).trim().split("\n").at(-1)!.split(" ")
        .map(Number);
      if (values.length === 3 && values.every(Number.isFinite)) {
        cpuUserSeconds = number(values[0]);
        cpuSystemSeconds = number(values[1]);
        peakRssKiB = number(values[2]);
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) failed(e);
    }
  }
  const outcome: BuildOutcome = {
    code: nativeStatus.code,
    signal: nativeStatus.signal,
    wallSeconds: (performance.now() - start) / 1000,
    cpuUserSeconds,
    cpuSystemSeconds,
    peakRssKiB,
    escalated,
    stdioMode,
  };
  try {
    const started = await Deno.stat(receipt + (time ? ".native.started" : ".started"));
    nativeStarted = started.isFile;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) failed(e);
  }
  if (!nativeReceipt && !escalated && !(cancelled && outcome.signal)) {
    failed(new Error("Нативный процесс не оставил подтверждённого результата"));
  }
  return {
    outcome,
    knownNativeOutcome: nativeStarted && (nativeReceipt || escalated) ? outcome : undefined,
  };
}
