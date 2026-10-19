import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProposedChange } from "./result.js";

export const PATCH_BASE_MISSING = "PATCH_BASE_MISSING";
export const PATCH_BASE_MISMATCH = "PATCH_BASE_MISMATCH";
export const PATCH_ANCHOR_ABSENT = "PATCH_ANCHOR_ABSENT";
export const PATCH_ANCHOR_NOT_UNIQUE = "PATCH_ANCHOR_NOT_UNIQUE";

/** sha256 over utf8 content, digested the way excerpts are labeled in prompts. */
export function fileDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export interface StagedWrite {
  path: string;
  content: string;
  label: "created" | "modified" | "patched";
}

export type StagedChanges =
  | { ok: true; writes: StagedWrite[]; deletes: string[] }
  | { ok: false; code: string; message: string };

function countOccurrences(haystack: string, needle: string): number {
  // Overlapping: an ambiguous anchor ("aa" inside "aaa") must read as
  // non-unique, so the applicator refuses instead of picking a spot.
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count += 1;
    i += 1;
  }
  return count;
}

function truncate(s: string, max = 60): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Stage a change set against the worktree WITHOUT touching disk: every op
 * is applied to an in-memory overlay in array order, so a later patch can
 * anchor on an earlier op's output for the same path. Any refusal - missing
 * base file, stale base digest, absent or non-unique anchor - rejects the
 * ENTIRE set: the caller performs writes only on ok, so a refused set
 * leaves the tree untouched (all-or-nothing). Anchors match exact bytes;
 * there is no normalization, fuzzy fallback, or repair, ever.
 */
export function stageChanges(worktreeRoot: string, changes: readonly ProposedChange[]): StagedChanges {
  const overlay = new Map<string, string>();
  const labels = new Map<string, StagedWrite["label"]>();
  const deletes = new Set<string>();

  for (const change of changes) {
    if (change.op === "delete") {
      overlay.delete(change.path);
      labels.delete(change.path);
      deletes.add(change.path);
      continue;
    }
    deletes.delete(change.path);
    if (change.op === "create" || change.op === "update") {
      overlay.set(change.path, change.content);
      labels.set(change.path, change.op === "create" ? "created" : "modified");
      continue;
    }

    let base: string;
    if (overlay.has(change.path)) {
      base = overlay.get(change.path)!;
    } else {
      try {
        base = readFileSync(path.join(worktreeRoot, change.path), "utf8");
      } catch {
        return {
          ok: false,
          code: PATCH_BASE_MISSING,
          message: `${PATCH_BASE_MISSING}: ${change.path} does not exist; a patch op needs an existing base`,
        };
      }
    }

    const actualDigest = fileDigest(base);
    if (actualDigest !== change.baseDigest) {
      return {
        ok: false,
        code: PATCH_BASE_MISMATCH,
        message: `${PATCH_BASE_MISMATCH}: ${change.path} content digests to ${actualDigest}, but the op declared ${change.baseDigest}; the file changed since it was read - re-read and restate, nothing was applied`,
      };
    }

    const occurrences = countOccurrences(base, change.anchor);
    if (occurrences === 0) {
      return {
        ok: false,
        code: PATCH_ANCHOR_ABSENT,
        message: `${PATCH_ANCHOR_ABSENT}: ${change.path} does not contain the anchor "${truncate(change.anchor)}" exactly; anchors match raw bytes with no normalization`,
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        code: PATCH_ANCHOR_NOT_UNIQUE,
        message: `${PATCH_ANCHOR_NOT_UNIQUE}: anchor "${truncate(change.anchor)}" occurs ${occurrences} times in ${change.path}; anchor on a longer unique span instead`,
      };
    }

    overlay.set(change.path, base.replace(change.anchor, change.replacement));
    labels.set(change.path, "patched");
  }

  const writes: StagedWrite[] = [...overlay.entries()].map(([p, content]) => ({
    path: p,
    content,
    label: labels.get(p) ?? "modified",
  }));
  return { ok: true, writes, deletes: [...deletes] };
}
