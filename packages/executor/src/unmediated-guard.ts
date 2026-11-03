import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { globMatchAny } from "@spc/core";
import { statusPorcelain } from "@spc/repo";
import { fileDigest } from "./patch.js";

/**
 * The submission-boundary predicate (specs/unmediated-change-guard):
 * a task cannot submit unmediated changes under its write targets,
 * regardless of whether its patch proposal is empty - a nonempty
 * proposal does not disguise a direct edit on another path. Evaluated
 * BEFORE any staging or application; refusals consume no attempt.
 *
 * Attribution is exact, never inferred: a prior attempt number or a
 * signpost note is not proof. A dirty path is covered only by a
 * durable record for THIS task carrying that path's content digest
 * captured when the work was attributed - the currently observed
 * content must still hash to it. Committed edits (HEAD off the
 * dispatch baseline) are the same violation on a clean status and
 * cannot be covered by attribution: the executor never commits
 * mid-task, so conservative refusal is exact here.
 *
 * Honest scope (UCG-004): this guard refuses unaccounted-for
 * git-visible mutation at submission. It does not prove every
 * accepted mutation passed composition controls - stageChanges binds
 * patch ops to CURRENT content and create/update carry no digest
 * binding - and it does not change those semantics.
 */

export interface AttributionWrite {
  path: string;
  /** Digest of the path's content captured when the work was attributed. */
  digest: string;
  kind: "applied" | "declared";
}

export interface AttributionRecord {
  writes: readonly AttributionWrite[];
}

export interface SubmissionCheckInput {
  worktreeRoot: string;
  /** The revision the answer was composed against (dispatch baseline). */
  baselineRevision: string;
  writeTargets: readonly string[];
  /** Paths named by the answer's changes array - never consulted for
   *  coverage: proposing a path does not launder a direct edit on it. */
  proposedPaths: readonly string[];
  attribution: AttributionRecord;
  /** Version-skew evidence (specs/version-skew-guard): the run's
   *  attribution store exists (default true), and the run's event log
   *  records prior FILE_CHANGED work (default false). Recorded work
   *  without a store is a signature no current-binary run can produce. */
  attributionStoreExists?: boolean;
  priorRecordedWork?: boolean;
}

export interface SubmissionCheck {
  decision: "allow" | "refuse";
  code?: "UNMEDIATED_CHANGES" | "GUARD_VERSION_SKEW";
  unattributed: string[];
  message?: string;
}

const RECOVERY =
  "revert the unattributed changes and propose them as patch operations (multi-op chains compose in one invocation: spc patch build --batch <spec.json>; a single follow-up chains with spc patch build --after <ops.json>; then spc patch verify, spc agent dry-run, spc agent submit)";

export function evaluateSubmission(input: SubmissionCheckInput): SubmissionCheck {
  const { worktreeRoot, baselineRevision, writeTargets, attribution } = input;

  // Committed bypass: an execution tree whose HEAD moved off the task's
  // dispatch baseline carries unmediated change whether or not git
  // status is clean. Nothing in the executor flow commits mid-task, so
  // refusal here is exact rather than conservative.
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktreeRoot, encoding: "utf8" });
  if (head.status === 0 && head.stdout.trim() !== baselineRevision) {
    return {
      decision: "refuse",
      code: "UNMEDIATED_CHANGES",
      unattributed: [],
      message: `HEAD ${head.stdout.trim().slice(0, 12)} diverged from the dispatch baseline ${baselineRevision.slice(0, 12)} - committed edits are unmediated changes; ${RECOVERY}`,
    };
  }

  // Working-tree dirt under the task's own write targets (untracked
  // included: status --porcelain -uall never collapses directories).
  // Dirt outside the targets never triggers - it is not this task's
  // mutation to account for. A worktree that is not a git repository
  // cannot be dirt-checked at all: the guard degrades honestly to
  // allow (the write-scope enforcement on proposed changes still
  // holds) rather than crash - production worktrees are always repos.
  let status: ReturnType<typeof statusPorcelain>;
  try {
    status = statusPorcelain(worktreeRoot);
  } catch {
    return { decision: "allow", unattributed: [] };
  }
  const under = [...status.entries.keys()].filter(
    (p) => globMatchAny(writeTargets, p) || globMatchAny(writeTargets, p.split(path.sep).join("/")),
  );

  const unattributed = under.filter((p) => {
    const record = attribution.writes.find((w) => w.path === p);
    if (!record) return true;
    try {
      return fileDigest(readFileSync(path.join(worktreeRoot, p), "utf8")) !== record.digest;
    } catch {
      return true; // unreadable or deleted: not the attributed work
    }
  });

  if (unattributed.length > 0) {
    // Version-skew naming (specs/version-skew-guard): recorded prior
    // work with no attribution store is impossible for a current-binary
    // run - the refusal names its true cause, because the remedy
    // differs: restart the run, do not revert and re-propose.
    if (input.attributionStoreExists === false && input.priorRecordedWork === true) {
      return {
        decision: "refuse",
        code: "GUARD_VERSION_SKEW",
        unattributed,
        message: `GUARD_VERSION_SKEW: ${unattributed.join(", ")} is dirty under the task's write targets while the run recorded prior work but has no attribution store - a run binary that predates attribution recording; the dirt is likely its own unrecorded mediated work - restart the run on the current binary.`,
      };
    }
    return {
      decision: "refuse",
      code: "UNMEDIATED_CHANGES",
      unattributed,
      message: `unmediated changes under the task's write targets: ${unattributed.join(", ")} - ${RECOVERY}`,
    };
  }
  return { decision: "allow", unattributed: [] };
}
