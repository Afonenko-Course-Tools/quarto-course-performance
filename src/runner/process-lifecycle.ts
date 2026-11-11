import { parseObject } from "../json.ts";
import { groupExists, liveGroup, ownedGroups, readOwnedGroup } from "./process-tree.ts";
import type { OwnedProcessOptions } from "./process.ts";
import { recordCancellation } from "./resource-child.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Единственный владелец сигналов, регистрации PGID и завершения собственного дерева. */
export function createProcessLifecycle(
  options: OwnedProcessOptions,
  receipt: string,
  failed: (error: unknown) => void,
  failure: () => unknown,
) {
  const cancelPath = receipt + ".cancel", spawnLock = receipt + ".spawn-lock";
  let group: number | undefined,
    pending: Deno.Signal | undefined,
    signalledAt = 0,
    escalated = false;
  const sent = new Set<number>();
  const signalGroup = (target: number, signal: Deno.Signal) => {
    try {
      Deno.kill(-target, signal);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) failed(error);
    }
  };
  const spawning = () => {
    try {
      Deno.statSync(spawnLock);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      failed(error);
      return true;
    }
  };
  const send = (signal: Deno.Signal) => {
    pending ??= signal;
    try {
      // До проверки ownership ранняя отмена остаётся в очереди: helper должен
      // удерживать parent-chain. Scanner failure отменяет само ожидание регистрации.
      if (group || failure()) recordCancellation(cancelPath, pending);
    } catch (error) {
      failed(error);
    }
    if (group) signalledAt ||= performance.now();
    // Spawn, начатый до cancel, завершится до группового TERM. Ещё не начатый
    // helper увидит cancel receipt и не породит child после этого сигнала.
    if (group && !sent.has(group) && !spawning()) {
      signalGroup(group, pending);
      sent.add(group);
    }
  };
  const term = () => send("SIGTERM"), interrupt = () => send("SIGINT");
  const abort = () => send(options.abortSignal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM");
  Deno.addSignalListener("SIGTERM", term);
  Deno.addSignalListener("SIGINT", interrupt);
  options.abortSignal?.addEventListener("abort", abort);
  if (options.abortSignal?.aborted) abort();
  const observeReadiness = async (root: number, sessions: Set<number>) => {
    if (!group && !failure()) {
      try {
        const candidate = await readOwnedGroup(receipt + ".ready");
        const owned = await ownedGroups(root, sessions);
        // Регистрационный helper удерживает живую group до ack: любой
        // неподтверждённый candidate — ошибка, даже если такой PGID не существует.
        if (!owned.has(candidate)) {
          throw new Error("PGID readiness не принадлежит собственной session");
        }
        group = candidate;
        if (pending) send(pending);
        // sessions уже сохранены, пока ожидающий helper удерживает parent-chain.
        await Deno.writeTextFile(receipt + ".registered", "");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) failed(error);
      }
    }
    if (group && !signalledAt) {
      try {
        const notice = parseObject(await Deno.readTextFile(receipt + ".signal"));
        if (notice.signal !== "SIGINT" && notice.signal !== "SIGTERM") {
          throw new Error("Некорректный signal receipt");
        }
        // Этот сигнал PTY уже доставил; повторной пересылки нет.
        pending = notice.signal;
        sent.add(group);
        signalledAt = performance.now();
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) failed(error);
      }
    }
  };
  const inspectRemaining = async (root: number, sessions: Set<number>) => {
    let remaining = new Set<number>(), scannerFailed = false;
    try {
      remaining = failure()
        ? await ownedGroups(root, sessions, failed)
        : new Set(group && await liveGroup(group) ? [group] : []);
      // Даже stale ancestry snapshot не отменяет уже подтверждённое владение group.
      if (failure() && group && await liveGroup(group, failed)) remaining.add(group);
    } catch (error) {
      failed(error);
      scannerFailed = true;
      // Ошибка scanner не обходит stop/wait/drain. Только ранее подтверждённая
      // group известна без нового снимка; candidate из readiness здесь не доверяем.
      if (group) remaining.add(group);
    }
    // В аварийном снимке нечитаемый PID не даёт нового ownership. Подтверждённая
    // group всё равно получает stop/escalation, даже если её stat недоступен.
    if (failure() && group && !escalated && groupExists(group)) remaining.add(group);
    return { remaining, scannerFailed };
  };
  const stopRemaining = (root: number, remaining: Set<number>) => {
    if (failure()) {
      send(pending ?? "SIGTERM");
      // Proxy script завершается после native group; не сигналим ему TERM,
      // иначе script способен повторно переслать уже доставленный сигнал.
      const targets = remaining.size > 1
        ? [...remaining].filter((g) => g !== root)
        : [...remaining];
      for (const target of targets) {
        if (!sent.has(target) && !spawning()) {
          signalGroup(target, "SIGTERM");
          sent.add(target);
        }
      }
      signalledAt ||= performance.now();
    }
  };
  return {
    async wait(
      child: Deno.ChildProcess,
      streams: { drained: Promise<void>; finished: () => boolean },
      releaseKeeper: () => void,
    ) {
      const sessions = new Set([child.pid]);
      let status: Deno.CommandStatus | undefined;
      const completed = child.status.then((s) => {
        status = s;
      });
      while (true) {
        await observeReadiness(child.pid, sessions);
        if (group && pending) send(pending);
        if (group || status || failure()) releaseKeeper();
        const { remaining, scannerFailed } = await inspectRemaining(child.pid, sessions);
        stopRemaining(child.pid, remaining);
        if (status && remaining.size === 0) break;
        // При отказе самой enumeration повторный /proc snapshot невозможен.
        // После KILL только подтверждённых групп ждём child и EOF обоих потоков;
        // zombie-only kernel PGID не заставляет supervisor зависнуть навсегда.
        if (scannerFailed && escalated && status && streams.finished()) break;
        if (signalledAt && performance.now() - signalledAt > (options.graceMilliseconds ?? 2000)) {
          for (const target of remaining) {
            if (!escalated) signalGroup(target, "SIGKILL");
          }
          if (remaining.size) escalated = true;
        }
        await pause(10);
      }
      await completed;
      await streams.drained;
      return { status: status!, escalated, cancelled: pending !== undefined };
    },
    dispose() {
      Deno.removeSignalListener("SIGTERM", term);
      Deno.removeSignalListener("SIGINT", interrupt);
      options.abortSignal?.removeEventListener("abort", abort);
    },
  };
}
