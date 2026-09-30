import { existsSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import { git, gitOk } from "./git.js";

export const WORKTREE_ERROR = "SPC_WORKTREE_ERROR";

export interface RunWorktree {
  path: string;
  branch: string;
}

/**
 * Execution isolation: one Git worktree per run under .spc/worktrees/.
 * Branch naming: spc/<spec-id>/<run-id> (per-task worktrees append --<task>).
 * V0 never merges or pushes.
 */
export function createWorktree(
  repoRoot: string,
  specId: string,
  runId: string,
  worktreeRoot: string,
  options: { startPoint?: string } = {},
): RunWorktree {
  const branch = `spc/${specId}/${runId}`;
  const wtPath = path.join(worktreeRoot, runId);
  if (existsSync(wtPath)) {
    throw new SpcError(WORKTREE_ERROR, `worktree path already exists: ${wtPath}`);
  }
  const args = ["worktree", "add", "-b", branch, wtPath, ...(options.startPoint ? [options.startPoint] : [])];
  let r = git(repoRoot, args);
  if (!r.ok) {
    // Branch may already exist from an aborted attempt; try reusing it.
    const retry = git(repoRoot, [
      "worktree",
      "add",
      "-B",
      branch,
      wtPath,
      ...(options.startPoint ? [options.startPoint] : []),
    ]);
    if (!retry.ok) {
      throw new SpcError(WORKTREE_ERROR, `failed to create worktree: ${(retry.stderr || r.stderr).trim()}`);
    }
    r = retry;
  }
  void r;
  return { path: wtPath, branch };
}

export function worktreeExists(wtPath: string): boolean {
  return existsSync(path.join(wtPath, ".git"));
}

export function removeWorktree(repoRoot: string, wtPath: string): void {
  git(repoRoot, ["worktree", "remove", "--force", wtPath]);
}

export interface RunBranch {
  branch: string;
  /** Ref HEAD was on before the checkout; "HEAD" when detached. */
  previousBranch: string;
}

/**
 * execution.inPlace isolation: run in the repository checkout itself, on
 * the run branch (same naming as worktrees) instead of a separate
 * worktree. -B reuses a branch left by an aborted attempt, resetting it
 * to the current HEAD.
 */
export function checkoutRunBranch(repoRoot: string, specId: string, runId: string): RunBranch {
  const previousBranch = gitOk(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const branch = `spc/${specId}/${runId}`;
  const r = git(repoRoot, ["checkout", "-B", branch]);
  if (!r.ok) {
    throw new SpcError(WORKTREE_ERROR, `failed to check out run branch ${branch}: ${r.stderr.trim()}`);
  }
  return { branch, previousBranch };
}

/** Switch the checkout to `branch` without resetting it (resume, restore). */
export function checkoutBranch(repoRoot: string, branch: string): void {
  const r = git(repoRoot, ["checkout", branch]);
  if (!r.ok) {
    throw new SpcError(WORKTREE_ERROR, `failed to check out ${branch}: ${r.stderr.trim()}`);
  }
}
