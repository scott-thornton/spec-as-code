import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { git } from "./git.js";

/**
 * CONTENT-based task snapshots (external review #1). Status-code
 * comparison is blind to a file that is already dirty: task A leaves
 * src/shared.ts at " M", task B illegally rewrites it, the status is
 * still " M", and the transition-based delta reports nothing. Identity
 * here is per-path content:
 *
 *   tracked, modified vs HEAD  -> git's destination blob hash
 *   tracked, deleted           -> DELETED sentinel
 *   untracked                  -> sha256 of file content
 *   unchanged/absent           -> absent from the map
 *
 * Comparing two snapshots therefore catches every real content change
 * regardless of prior dirtiness.
 */

export interface ContentSnapshot {
  /** path -> content identity (blob hash / DELETED / content sha256) */
  entries: Map<string, string>;
}

export const DELETED = "<deleted>";

export function contentSnapshot(cwd: string): ContentSnapshot {
  const entries = new Map<string, string>();

  // Tracked modifications and deletions vs HEAD, with git's own content
  // identity: `git diff --raw HEAD` lists per-path source/dest blobs.
  const raw = git(cwd, ["diff", "--raw", "HEAD", "--no-abbrev"]).stdout;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split(/\t/);
    const pathField = parts[1] ?? "";
    if (pathField === "") continue;
    // Rename lines carry two tab-separated paths; the destination is ours.
    const p = parts.length > 2 ? parts[parts.length - 1]! : pathField;
    if (p.startsWith('"') && p.endsWith('"')) continue; // quoted paths: exotic, skip conservatively
    // --raw meta: ":<srcMode> <dstMode> <srcBlob> <dstBlob> <status>"
    const meta = (parts[0] ?? "").split(" ");
    const dstBlob = meta[3];
    const statusLetter = meta[4] ?? "";
    if (statusLetter.includes("D")) {
      entries.set(p, DELETED);
    } else if (dstBlob === "0000000000000000000000000000000000000000") {
      // Dest blob is all-zero for unmerged/adds in raw output; fall back
      // to content hashing so identity is still per-content.
      try {
        entries.set(p, "sha256:" + createHash("sha256").update(readFileSync(`${cwd}/${p}`)).digest("hex"));
      } catch {
        entries.set(p, "unknown");
      }
    } else {
      entries.set(p, dstBlob ?? "unknown");
    }
  }

  // Untracked files: sha256 of content (blob hashing via git would
  // pollute the object database; content hashing is equivalent for
  // change detection).
  const untracked = git(cwd, ["status", "--porcelain", "-uall"]).stdout;
  for (const line of untracked.split("\n")) {
    if (line.trim() === "") continue;
    const xy = line.slice(0, 2);
    let p = line.slice(3);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (!xy.includes("?")) continue;
    let hash: string;
    try {
      hash = "sha256:" + createHash("sha256").update(readFileSync(`${cwd}/${p}`)).digest("hex");
    } catch {
      hash = "unreadable";
    }
    entries.set(p, hash);
  }

  return { entries };
}

export type ContentChange = "created" | "modified" | "deleted";

/**
 * Paths whose content identity changed between two snapshots. With cwd,
 * a path present only in the after-snapshot is classified by
 * tracked-ness: snapshots are HEAD-diff based, so a task starting from
 * a clean tree has an empty before-map and every first touch of an
 * existing (tracked) file would otherwise mislabel as "created".
 */
export function contentDelta(
  before: ContentSnapshot,
  after: ContentSnapshot,
  cwd?: string,
): Map<string, ContentChange> {
  const out = new Map<string, ContentChange>();
  for (const [p, identity] of after.entries) {
    const prior = before.entries.get(p);
    if (prior === identity) continue;
    if (identity === DELETED) out.set(p, "deleted");
    else if (prior === undefined) {
      const tracked = cwd !== undefined && git(cwd, ["ls-files", "--error-unmatch", p]).ok;
      out.set(p, tracked ? "modified" : "created");
    } else out.set(p, "modified");
  }
  for (const [p, prior] of before.entries) {
    if (!after.entries.has(p)) {
      // Present before, absent after: either truly deleted (tracked
      // case would carry DELETED) or untracked-and-removed.
      out.set(p, "deleted");
      void prior;
    }
  }
  return out;
}
