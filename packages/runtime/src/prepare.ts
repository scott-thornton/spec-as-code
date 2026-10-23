import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";

export type PrepareMode = "installed" | "linked" | "none" | "failed";

export interface PrepareOutcome {
  mode: PrepareMode;
  exitCode?: number;
  detail?: string;
}

/**
 * One preparation mechanism for every disposable worktree (dry-run,
 * verify --run, the contamination guard): the environment must be
 * ready before criteria can meaningfully execute. pnpm workspaces get
 * an offline frozen install (a wholesale node_modules symlink is
 * refused by pnpm's task-state guard and compiles against stale
 * siblings); flat repositories link the root install; a repository
 * with neither reports none honestly. A failure here is an environment
 * fact, never a behavioral verdict - callers record it and classify
 * their observations accordingly.
 */
export function prepareDisposableWorktree(repoRoot: string, worktree: string): PrepareOutcome {
  const pnpmLock = existsSync(path.join(repoRoot, "pnpm-lock.yaml"));
  if (pnpmLock) {
    const r = spawnSync("pnpm", ["install", "--frozen-lockfile", "--offline"], {
      cwd: worktree,
      encoding: "utf8",
      timeout: 120_000,
    });
    const tail = ((r.stderr ?? "") + (r.stdout ?? "")).trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
    if (r.status === 0) return { mode: "installed", exitCode: 0 };
    return { mode: "failed", exitCode: r.status ?? -1, detail: tail.slice(0, 200) };
  }
  const depsSource = path.join(repoRoot, "node_modules");
  if (existsSync(depsSource) && !existsSync(path.join(worktree, "node_modules"))) {
    symlinkSync(depsSource, path.join(worktree, "node_modules"), "dir");
    return { mode: "linked" };
  }
  return { mode: "none" };
}
