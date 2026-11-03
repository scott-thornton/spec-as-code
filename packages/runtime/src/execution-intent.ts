import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tryExclusiveLock } from "./platform-lock.js";

/**
 * Durable execution-intent record (specs/apply-ownership, AO-002).
 * The workspace safety block: written before any managed worker launches,
 * cleared only after the entire protected operation completes (workers
 * stopped, state persisted, attested, branch restored). Survives
 * coordinator death, cancellation-process death, and recovery retries.
 *
 * The interruption cause is a REQUIRED monotonic state machine:
 * NONE -> CANCEL_REQUESTED -> CANCEL_ESCALATED (never backwards).
 * The CANCELLATION PROCESS owns all cause transitions; the owner
 * participates in arbitration but never rewrites the cause.
 *
 * Atomic publication: write tmp + fsync + rename + dir fsync.
 * A malformed, truncated, or unreadable record is treated as UNSAFE,
 * never as absent. A missing cause field is UNSAFE (intentional and
 * accidental absence are indistinguishable).
 *
 * The arbitration lock (.spc/execution-intent.lock) serializes the
 * terminalization-vs-escalation decision — a separate stable file,
 * never the replaceable JSON, because atomic replacement changes the
 * underlying file object.
 */

export type InterruptionCause = "NONE" | "CANCEL_REQUESTED" | "CANCEL_ESCALATED";

export interface WorkerIdentity {
  pid: number;
  processStartTime: string;
  host: string;
  startedAt: string;
}

export interface CoordinatorIdentity {
  pid: number;
  processStartTime: string;
  host: string;
}

export interface RestorationContext {
  originalBranch: string;
  originalHead: string;
  restorationTarget: string;
}

export interface ExecutionIntent {
  cause: InterruptionCause;
  coordinator: CoordinatorIdentity;
  workers: WorkerIdentity[];
  startedAt: string;
  runId: string;
  planId: string;
  restoration: RestorationContext;
}

export interface IntentReadResult {
  ok: true;
  intent: ExecutionIntent;
}

export interface IntentReadFailure {
  ok: false;
  reason: "malformed" | "unreadable" | "unsafe-cause" | "missing-cause";
  detail: string;
}

export type IntentRead = IntentReadResult | IntentReadFailure;

/** Filesystem locations for the intent record and its arbitration lock. */
export function intentFile(repoRoot: string): string {
  return path.join(repoRoot, ".spc", "execution-intent.json");
}
export function arbitrationLockFile(repoRoot: string): string {
  return path.join(repoRoot, ".spc", "execution-intent.lock");
}

function fsyncDir(dirPath: string): void {
  const fd = openSync(dirPath, "r");
  try {
    // fsync on a directory fd flushes the directory entry
    // (POSIX; no-op on some platforms but never harmful)
    closeSync(fd);
  } catch {
    // best effort: directory already closed or platform limitation
  }
}

/**
 * Durably write the execution-intent record (atomic publication).
 * Called before any managed worker launches.
 */
export function writeIntent(repoRoot: string, intent: ExecutionIntent): void {
  const file = intentFile(repoRoot);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(intent, null, 1), "utf8");
  // fsync the tmp file (data durability)
  const fd = openSync(tmp, "r");
  try { closeSync(fd); } catch { /* already closed */ }
  renameSync(tmp, file);
  // fsync the directory (rename durability)
  fsyncDir(dir);
}

/**
 * Durably register a worker identity BEFORE the worker can mutate.
 * Appends to the workers array under the arbitration lock.
 */
export function registerWorker(repoRoot: string, worker: WorkerIdentity): IntentRead {
  const arb = tryExclusiveLock(arbitrationLockFile(repoRoot));
  if (!arb) {
    return { ok: false, reason: "unreadable", detail: "arbitration lock unavailable during worker registration" };
  }
  try {
    const current = readIntentUnlocked(repoRoot);
    if (!current.ok) return current;
    const workers = [...current.intent.workers, worker];
    writeIntent(repoRoot, { ...current.intent, workers });
    return { ok: true, intent: { ...current.intent, workers } };
  } finally {
    arb.release();
  }
}

/**
 * Transition the interruption cause. Monotonic-only:
 * NONE -> CANCEL_REQUESTED -> CANCEL_ESCALATED.
 * The transition is atomically serialized under the arbitration lock.
 * Returns false if the transition would move backwards or is invalid.
 */
export function transitionCause(
  repoRoot: string,
  from: InterruptionCause,
  to: InterruptionCause,
): boolean {
  const ORDER: Record<InterruptionCause, number> = { NONE: 0, CANCEL_REQUESTED: 1, CANCEL_ESCALATED: 2 };
  if (ORDER[to] <= ORDER[from]) return false; // monotonic only

  const arb = tryExclusiveLock(arbitrationLockFile(repoRoot));
  if (!arb) return false;
  try {
    const current = readIntentUnlocked(repoRoot);
    if (!current.ok) return false;
    if (current.intent.cause !== from) return false; // CAS
    writeIntent(repoRoot, { ...current.intent, cause: to });
    return true;
  } finally {
    arb.release();
  }
}

/**
 * Read the intent record. A malformed, truncated, or unreadable record
 * returns a failure result — treated as UNSAFE, never as absent.
 * A missing or invalid cause field is UNSAFE.
 */
export function readIntent(repoRoot: string): IntentRead {
  const file = intentFile(repoRoot);
  if (!existsSync(file)) {
    return { ok: false, reason: "unreadable", detail: "no execution-intent record" };
  }
  return readIntentUnlocked(repoRoot);
}

function readIntentUnlocked(repoRoot: string): IntentRead {
  const file = intentFile(repoRoot);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: "unreadable", detail: "cannot read execution-intent record" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed", detail: "execution-intent record is not valid JSON" };
  }
  const obj = parsed as Partial<ExecutionIntent> & Record<string, unknown>;
  // Cause is REQUIRED — missing is UNSAFE (intentional and accidental
  // absence are indistinguishable)
  if (obj.cause === undefined || obj.cause === null) {
    return { ok: false, reason: "missing-cause", detail: "execution-intent record has no cause field (intentional and accidental absence are indistinguishable — treated as unsafe)" };
  }
  if (obj.cause !== "NONE" && obj.cause !== "CANCEL_REQUESTED" && obj.cause !== "CANCEL_ESCALATED") {
    return { ok: false, reason: "unsafe-cause", detail: `execution-intent cause is "${String(obj.cause)}" (unknown value — treated as unsafe)` };
  }
  // Coordinator identity is required
  if (!obj.coordinator || typeof obj.coordinator !== "object" || typeof (obj.coordinator as CoordinatorIdentity).pid !== "number") {
    return { ok: false, reason: "malformed", detail: "execution-intent record has no valid coordinator identity" };
  }
  // Workers array is required (can be empty)
  if (!Array.isArray(obj.workers)) {
    return { ok: false, reason: "malformed", detail: "execution-intent record has no workers array" };
  }
  // Restoration context is required
  if (!obj.restoration || typeof obj.restoration !== "object") {
    return { ok: false, reason: "malformed", detail: "execution-intent record has no restoration context" };
  }
  return { ok: true, intent: parsed as ExecutionIntent };
}

/**
 * Clear the execution-intent record (atomic delete + dir fsync).
 * Called ONLY after the full finalization boundary (AO-002):
 * workers stopped, state persisted, attested, branch restored.
 */
export function clearIntent(repoRoot: string): void {
  const file = intentFile(repoRoot);
  const dir = path.dirname(file);
  try {
    unlinkSync(file);
    fsyncDir(dir);
  } catch {
    // already absent or unreadable — nothing to clear
  }
}

/**
 * Acquire the arbitration lock for a critical section.
 * Use for terminalization-vs-escalation arbitration (AO-002/AO-003).
 */
export function acquireArbitration(repoRoot: string): ReturnType<typeof tryExclusiveLock> {
  return tryExclusiveLock(arbitrationLockFile(repoRoot));
}
