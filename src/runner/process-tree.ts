import { parseObject } from "../json.ts";

export function groupExists(group: number): boolean {
  try {
    Deno.kill(-group, 0);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
// /proc entry может исчезнуть между open и read: Linux возвращает ESRCH,
// которое Deno 2.7 представляет обычным Error, а не Deno.errors.NotFound.
function vanishedProcEntry(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound || error instanceof Error &&
      /^No such process \(os error 3\)(?:: readfile '\/proc\/\d+\/stat')?$/.test(error.message);
}
async function scanGroup(
  group: number,
  cleanupError?: (error: unknown) => void,
): Promise<{ live: boolean; zombies: number }> {
  let zombies = 0;
  for await (const entry of Deno.readDir("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const stat = await Deno.readTextFile(`/proc/${entry.name}/stat`);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) !== group) continue;
      if (fields[0] !== "Z") return { live: true, zombies };
      zombies++;
    } catch (error) {
      if (!vanishedProcEntry(error)) {
        if (!cleanupError) throw error;
        cleanupError(error);
      }
    }
  }
  return { live: false, zombies };
}
export async function liveGroup(
  group: number,
  cleanupError?: (error: unknown) => void,
): Promise<boolean> {
  if (!groupExists(group)) return false;
  if ((await scanGroup(group, cleanupError)).live) return true;
  if (!groupExists(group)) return false;
  // Directory enumeration могла начаться до fork, а stat parent — после exit.
  // Новый снимок подтверждает zombie-only; пустота при существующей kernel group
  // остаётся неопределённостью, которую обычный цикл перепроверит без раннего return.
  const confirmed = await scanGroup(group, cleanupError);
  if (confirmed.live) return true;
  if (confirmed.zombies > 0) return false;
  return groupExists(group);
}
export async function readOwnedGroup(path: string): Promise<number> {
  const value = parseObject(await Deno.readTextFile(path));
  if (typeof value.group !== "number" || !Number.isSafeInteger(value.group) || value.group <= 1) {
    throw new Error("Некорректный PGID в readiness receipt");
  }
  return value.group;
}

// Только аварийный путь до доверенного receipt: session создана нашим setsid PID.
// Дополнительные session признаются своими лишь по фактическому родству с ним.
export async function ownedGroups(
  root: number,
  sessions: Set<number>,
  cleanupError?: (error: unknown) => void,
): Promise<Set<number>> {
  const processes = new Map<
    number,
    { parent: number; group: number; session: number; live: boolean }
  >();
  for await (const entry of Deno.readDir("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const stat = await Deno.readTextFile(`/proc/${entry.name}/stat`);
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      processes.set(Number(entry.name), {
        parent: Number(f[1]),
        group: Number(f[2]),
        session: Number(f[3]),
        live: f[0] !== "Z",
      });
    } catch (error) {
      if (!vanishedProcEntry(error)) {
        if (!cleanupError) throw error;
        cleanupError(error);
      }
    }
  }
  const descendants = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, process] of processes) {
      if (!descendants.has(pid) && descendants.has(process.parent)) {
        descendants.add(pid);
        sessions.add(process.session);
        changed = true;
      }
    }
  }
  const own = processes.get(Deno.pid)?.session;
  return new Set(
    [...processes.values()].filter((p) =>
      p.live && p.group > 1 &&
      p.session !== own && sessions.has(p.session)
    ).map((p) => p.group),
  );
}
