import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpcError } from "@spc/core";
import { compileSpecFile } from "@spc/repo";

/**
 * The workspace apply lease (specs/apply-lease): one live apply per
 * workspace. The receipts: a mis-fed second apply mid-flight, a sibling
 * double-start (two live processes, one queue), and a phase-11-era zombie
 * still requeuing in a later phase's workspace - nothing registered live
 * apply processes, so all three interleaved silently over one harness
 * queue and one plan namespace. The lease converts coexistence into a
 * named, decided refusal (APPLY_ALREADY_RUNNING): check-then-decide, never
 * wait - an agent told to wait waits indefinitely. Dead-pid leases are
 * silently reclaimed (crashed processes cost nothing); --allow-concurrent
 * is the only door past a live holder; the lease never kills anything -
 * spc run cancel stays the sanctioned termination.
 */

export interface ApplyLease {
  pid: number;
  host: string;
  runId: string;
  planId: string;
  specId: string;
  specTitle: string;
  specDigest: string;
  mode: "in-place" | "worktree";
  startedAt: string;
}

export function leasePath(repoRoot: string): string {
  return path.join(repoRoot, ".spc", "apply.lease");
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function readLease(repoRoot: string): ApplyLease | null {
  try {
    return JSON.parse(readFileSync(leasePath(repoRoot), "utf8")) as ApplyLease;
  } catch {
    return null; // absent or corrupt: nothing held
  }
}

export function writeLease(repoRoot: string, lease: ApplyLease): void {
  mkdirSync(path.join(repoRoot, ".spc"), { recursive: true });
  const tmp = leasePath(repoRoot) + ".tmp";
  writeFileSync(tmp, JSON.stringify(lease, null, 1), "utf8");
  renameSync(tmp, leasePath(repoRoot));
}

export function releaseLease(repoRoot: string): void {
  try {
    rmSync(leasePath(repoRoot), { force: true });
  } catch {
    // best effort; dead-pid reclaim self-heals a missed release
  }
}

/** "3h12m" style live duration from an ISO start. */
export function durationHm(fromIso: string, now: Date = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(fromIso)) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/**
 * Resolve the CURRENT file for a spec id at refusal time - never a path
 * recorded at lease start, which can go stale while a zombie holds the
 * lease. No match = the stale-file signal itself.
 */
export function resolveSpecFileNow(repoRoot: string, specId: string): string | null {
  const specsDir = path.join(repoRoot, "specs");
  if (!existsSync(specsDir)) return null;
  for (const f of readdirSync(specsDir).sort()) {
    if (!f.endsWith(".yaml")) continue;
    const compiled = compileSpecFile(path.join(specsDir, f));
    if (compiled.ok && compiled.ir && compiled.ir.spec.metadata.id === specId) {
      return `specs/${f}`;
    }
  }
  return null;
}

export function buildRefusalMessage(lease: ApplyLease, incomingSpecId: string | undefined, resolvedFile: string | null, extra?: string): string {
  const lines = [
    `this workspace's apply lease is held by`,
    `  run ${lease.runId}  spec: ${lease.specId} - "${lease.specTitle}"`,
    `  file: ${resolvedFile ?? `(no live spec file for ${lease.specId} - renamed or removed since launch)`}`,
    `  plan ${lease.planId}  pid ${lease.pid}  mode ${lease.mode}  live ${durationHm(lease.startedAt)}${lease.host !== os.hostname() ? `  (held on host ${lease.host})` : ""}`,
    ...(extra ? [extra] : []),
    ``,
    `Concurrent applies share one harness queue and one plan namespace;`,
    `this launch refused rather than interleave.`,
    ``,
    `Check it:    spc run show ${lease.runId}   (live state, pending requests against windows, spec drift)`,
    `Then decide: spc run cancel ${lease.runId} (stale, stuck, or superseded)`,
  ];
  if (incomingSpecId !== undefined && incomingSpecId === lease.specId) {
    lines.push(``, `This is a concurrent apply of the SAME spec - almost certainly a double-start; cancel one.`);
  }
  return lines.join("\n");
}

/**
 * The entry check: refuse past a live holder, allow with warning when
 * forced, silently reclaim a dead holder's lease. Returns the lease to
 * write once the runId exists (callers write it before dispatch).
 */
export function checkApplyLease(input: {
  repoRoot: string;
  incomingSpecId: string;
  allowConcurrent?: boolean;
  log?: (line: string) => void;
}): { refused?: string; mode: "in-place" | "worktree" } {
  const lease = readLease(input.repoRoot);
  if (lease && pidAlive(lease.pid)) {
    if (!input.allowConcurrent) {
      const file = resolveSpecFileNow(input.repoRoot, lease.specId);
      throw new SpcError("APPLY_ALREADY_RUNNING", buildRefusalMessage(lease, input.incomingSpecId, file));
    }
    input.log?.(`concurrent apply: proceeding alongside live run ${lease.runId} (pid ${lease.pid}) - harness queue and plan namespace are shared`);
  }
  return { mode: "in-place" };
}
