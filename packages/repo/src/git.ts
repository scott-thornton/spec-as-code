import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";

export const GIT_ERROR = "SPC_GIT_ERROR";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const SPC_IDENTITY_ARGS = ["-c", "user.name=spc", "-c", "user.email=spc@local"];

/**
 * spc-made commits defer to the repository's configured git identity -
 * the human whose contract is running - so attribution, blame and history
 * stay with the user. The fixed spc identity is only a fallback for
 * environments where git cannot resolve one at all (bare CI runners),
 * where the commit would otherwise fail outright. Resolved once per repo
 * per process: the probe is a full spawnSync and commit-heavy paths call
 * this for every commit.
 */
const identityCache = new Map<string, string[]>();
function commitIdentityArgs(cwd: string): string[] {
  const cached = identityCache.get(cwd);
  if (cached !== undefined) return cached;
  const args = git(cwd, ["var", "GIT_AUTHOR_IDENT"]).ok ? [] : SPC_IDENTITY_ARGS;
  identityCache.set(cwd, args);
  return args;
}

/**
 * Thin, synchronous Git adapter. All commands are explicit and captured;
 * nothing is shell-interpolated from untrusted input.
 */
export function git(cwd: string, args: string[], options: { identity?: boolean; input?: string } = {}): GitResult {
  const finalArgs = options.identity ? [...commitIdentityArgs(cwd), ...args] : args;
  const r = spawnSync("git", finalArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status,
  };
}

export function gitOk(cwd: string, args: string[], options: { identity?: boolean; input?: string } = {}): string {
  const r = git(cwd, args, options);
  if (!r.ok) {
    throw new SpcError(GIT_ERROR, `git ${args.join(" ")} failed in ${cwd}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

/** Walk up from `start` to find the containing Git repository root. */
export function findRepoRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function isGitRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).ok;
}

export function currentRevision(cwd: string): string {
  return gitOk(cwd, ["rev-parse", "HEAD"]).trim();
}

export function currentBranch(cwd: string): string {
  return gitOk(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

export interface WorktreeStatus {
  dirty: boolean;
  /** path -> xy status letters from `git status --porcelain` */
  entries: Map<string, string>;
}

export function statusPorcelain(cwd: string): WorktreeStatus {
  // -uall: never collapse untracked directories; we need per-file paths
  // for write-scope enforcement.
  const out = gitOk(cwd, ["status", "--porcelain", "-uall"]);
  const entries = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const xy = line.slice(0, 2);
    let p = line.slice(3);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    entries.set(p, xy);
  }
  return { dirty: entries.size > 0, entries };
}

/** Paths changed between two status snapshots (created/modified/deleted). */
export function statusDelta(
  before: WorktreeStatus,
  after: WorktreeStatus,
): Map<string, "created" | "modified" | "deleted"> {
  const out = new Map<string, "created" | "modified" | "deleted">();
  for (const [p, xy] of after.entries) {
    const prior = before.entries.get(p);
    if (prior === xy) continue;
    const untracked = xy.includes("?");
    const added = xy.startsWith("A") || xy.endsWith("A");
    const deleted = xy.includes("D");
    out.set(p, deleted ? "deleted" : untracked || added ? "created" : "modified");
  }
  return out;
}

export function diffStat(cwd: string, from: string, to: string): string {
  const r = git(cwd, ["diff", "--stat", `${from}..${to}`]);
  return r.stdout.trim();
}

export function diffPatch(cwd: string, from: string, to: string, maxBytes: number): string {
  const r = git(cwd, ["diff", `${from}..${to}`]);
  return Buffer.from(r.stdout, "utf8").subarray(0, maxBytes).toString("utf8");
}

/** spc-owned state directories; they never belong in result commits. */
const SPC_STATE_PATHS = [".spc/runs", ".spc/plans", ".spc/worktrees", ".spc/cache", ".spc/harness"];

export function commitAll(cwd: string, message: string): string | null {
  const status = statusPorcelain(cwd);
  if (!status.dirty) return null;
  // Identity matters only for operations that create commits; add/reset
  // never do.
  gitOk(cwd, ["add", "-A"]);
  // In-place execution commits inside a checkout that contains spc-owned
  // state (run logs, plans, worktrees, harness queues); unstage it. In
  // worktree mode the state lives outside the tree, so this is a no-op.
  // reset rather than an add exclude pathspec: naming an existing ignored
  // path in `git add` pathspecs makes git exit non-zero even though the
  // files stage correctly.
  gitOk(cwd, ["reset", "-q", "--", ...SPC_STATE_PATHS]);
  // Only spc state was dirty: nothing staged, nothing to commit.
  if (git(cwd, ["diff", "--cached", "--quiet"]).ok) return null;
  gitOk(cwd, ["commit", "-m", message], { identity: true });
  return currentRevision(cwd);
}
