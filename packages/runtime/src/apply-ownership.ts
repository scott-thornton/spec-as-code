import os from "node:os";
import { readIntent, writeIntent, clearIntent, type ExecutionIntent } from "./execution-intent.js";
import { tryExclusiveLock, type ExclusiveLock } from "./platform-lock.js";

/**
 * The apply ownership boundary (specs/apply-ownership, AO-001/AO-004/AO-005).
 * Every mutating apply entrypoint — fresh apply, --resume, quick, reconcile
 * — enters through this single function before creating or mutating any
 * artifact. The kernel lock arbitrates acquisition atomically; the safety
 * block (execution-intent record) gates execution after the lock is
 * acquired. Agents in different git worktrees apply concurrently (each
 * worktree has its own .spc/ and its own lock).
 */

export interface ApplyOwnerInfo {
  runId: string;
  planId: string;
  specId: string;
  specTitle: string;
  mode: "in-place" | "worktree";
}

export interface OwnershipHandle {
  lock: ExclusiveLock;
  owner: ApplyOwnerInfo;
}

export const APPLY_ALREADY_RUNNING = "APPLY_ALREADY_RUNNING";
export const APPLY_WORKSPACE_UNSAFE = "APPLY_WORKSPACE_UNSAFE";
export const APPLY_RECURSIVE = "APPLY_RECURSIVE";

function lockFile(repoRoot: string): string {
  return `${repoRoot}/.spc/apply.lock`;
}

/**
 * Detect a recursive spc apply invoked from inside an active SPC task.
 * The harness sets the run ID in the environment for task execution.
 */
function detectRecursiveApply(): string | null {
  const runId = process.env.SPC_ACTIVE_RUN_ID;
  if (runId) {
    return `recursive spc apply detected: this process is already executing a task in run ${runId}; an apply cannot be started from inside a task`;
  }
  return null;
}

/**
 * Acquire workspace ownership: kernel lock -> safety block check -> handle.
 * Returns the handle on success. Throws APPLY_ALREADY_RUNNING if another
 * coordinator holds the lock. Throws APPLY_WORKSPACE_UNSAFE if the safety
 * block (execution-intent from a prior interrupted run) is present.
 */
export function acquireOwnership(
  repoRoot: string,
  owner: ApplyOwnerInfo,
): OwnershipHandle {
  // Recursive-apply detection (AO-005)
  const recursive = detectRecursiveApply();
  if (recursive) {
    const e = new Error(recursive);
    (e as Error & { code?: string }).code = APPLY_RECURSIVE;
    throw e;
  }

  const lock = tryExclusiveLock(lockFile(repoRoot));
  if (!lock) {
    // Best-effort holder identity from the intent record
    const intent = readIntent(repoRoot);
    const holderInfo = intent.ok
      ? `run ${intent.intent.runId} (spec: ${intent.intent.runId}, plan ${intent.intent.planId}, pid ${intent.intent.coordinator.pid})`
      : `another process holds the workspace lock (no intent record readable)`;
    const e = new Error(
      `this workspace's apply lock is held by ${holderInfo}\n\n` +
      `Concurrent applies share one harness queue and one plan namespace;\n` +
      `this launch refused rather than interleave.\n\n` +
      `Check it:    spc apply owner   (three-authority report)\n` +
      `Then decide: spc run cancel <runId> (stale, stuck, or superseded)`,
    );
    (e as Error & { code?: string }).code = APPLY_ALREADY_RUNNING;
    throw e;
  }

  // Safety block check (AFTER lock acquisition — recovery is serialized)
  const intent = readIntent(repoRoot);
  if (intent.ok) {
    // An intent record from a prior run is present — the workspace may
    // be unsafe. Lock acquisition and execution permission are distinct.
    const e = new Error(
      `workspace safety block: execution-intent from run ${intent.intent.runId} is present\n` +
      `(cause: ${intent.intent.cause}, ${intent.intent.workers.length} worker(s) recorded)\n\n` +
      `The prior run may have been interrupted with workers still active.\n` +
      `Recover: spc apply recover\n` +
      `Inspect: spc apply owner`,
    );
    (e as Error & { code?: string }).code = APPLY_WORKSPACE_UNSAFE;
    lock.release();
    throw e;
  }

  return { lock, owner };
}

/**
 * Write the initial execution-intent record with cause NONE.
 * Called after acquiring ownership, before any managed worker launches.
 */
export function initializeIntent(
  repoRoot: string,
  handle: OwnershipHandle,
  restoration: { originalBranch: string; originalHead: string; restorationTarget: string },
): void {
  const intent: ExecutionIntent = {
    cause: "NONE",
    coordinator: {
      pid: process.pid,
      processStartTime: new Date(Date.now() - performance.now()).toISOString(),
      host: os.hostname(),
    },
    workers: [],
    startedAt: new Date().toISOString(),
    runId: handle.owner.runId,
    planId: handle.owner.planId,
    restoration,
  };
  writeIntent(repoRoot, intent);
}

/**
 * Release workspace ownership: clear intent + release lock.
 * Called after the full finalization boundary (AO-002).
 */
export function releaseOwnership(repoRoot: string, handle: OwnershipHandle | null): void {
  if (!handle) return;
  try {
    clearIntent(repoRoot);
  } finally {
    handle.lock.release();
  }
}

/**
 * The full ownership boundary for an apply entrypoint:
 * acquire -> initialize intent -> execute -> release.
 * The execute function receives the handle for pass-through to
 * delegated inner applies (quick -> applyPlan).
 */
export async function withApplyOwnership<T>(
  repoRoot: string,
  owner: ApplyOwnerInfo,
  restoration: { originalBranch: string; originalHead: string; restorationTarget: string },
  execute: (handle: OwnershipHandle) => Promise<T>,
): Promise<T> {
  const handle = acquireOwnership(repoRoot, owner);
  initializeIntent(repoRoot, handle, restoration);
  try {
    return await execute(handle);
  } finally {
    releaseOwnership(repoRoot, handle);
  }
}
