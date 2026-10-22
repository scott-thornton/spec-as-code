import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const RUN_LOCK_HELD = "RUN_LOCK_HELD";
export const RUN_LOCK_STALE_MS = 15 * 60 * 1000;

export interface ExecutionLock {
  pid: number;
  at: string;
  command?: string;
}

export type LockAcquisition =
  | { ok: true }
  | { ok: false; code: typeof RUN_LOCK_HELD; holderPid: number; holderAt: string };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One live process per run: the original apply still executing while a
 * resume started produced a self-breaking evidence log (run-mvix4mfx) -
 * two writers, two in-memory chains, one corrupted file. A live holder
 * is refused; a dead pid or a lock older than the stale window is
 * evidence the holder is gone, and is taken over. A process that dies
 * without releasing leaves its lock to the stale window - crash physics,
 * not tampering.
 */
export function acquireExecutionLock(
  runDir: string,
  pid: number,
  now: () => string,
  command = "spc apply",
): LockAcquisition {
  const file = path.join(runDir, "execution.lock");
  if (existsSync(file)) {
    try {
      const held = JSON.parse(readFileSync(file, "utf8")) as ExecutionLock;
      const age = Date.parse(now()) - Date.parse(held.at);
      const stale = Number.isNaN(age) || age > RUN_LOCK_STALE_MS;
      if (!stale && pidAlive(held.pid)) {
        return { ok: false, code: RUN_LOCK_HELD, holderPid: held.pid, holderAt: held.at };
      }
    } catch {
      // unreadable lock: treat as stale and take over
    }
  }
  mkdirSync(runDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ pid, at: now(), command }), "utf8");
  return { ok: true };
}

export function releaseExecutionLock(runDir: string): void {
  rmSync(path.join(runDir, "execution.lock"), { force: true });
}
