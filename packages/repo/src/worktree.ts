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
 * Branch naming: spc/<spec-id>/<run-id>. V0 never merges or pushes.
 */
export function createWorktree(repoRoot: string, specId: string, runId: string, worktreeRoot: string): RunWorktree {
  const branch = `spc/${specId}/${runId}`;
  const wtPath = path.join(worktreeRoot, runId);
  if (existsSync(wtPath)) {
    throw new SpcError(WORKTREE_ERROR, `worktree path already exists: ${wtPath}`);
  }
  const r = git(repoRoot, ["worktree", "add", "-b", branch, wtPath]);
  if (!r.ok) {
    // Branch may already exist from an aborted attempt; try reusing it.
    const retry = git(repoRoot, ["worktree", "add", "-B", branch, wtPath]);
    if (!retry.ok) {
      throw new SpcError(WORKTREE_ERROR, `failed to create worktree: ${(retry.stderr || r.stderr).trim()}`);
    }
  }
  return { path: wtPath, branch };
}

export function worktreeExists(wtPath: string): boolean {
  return existsSync(path.join(wtPath, ".git"));
}

export function removeWorktree(repoRoot: string, wtPath: string): void {
  git(repoRoot, ["worktree", "remove", "--force", wtPath]);
}
