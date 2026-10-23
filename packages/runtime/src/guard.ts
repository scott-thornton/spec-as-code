import path from "node:path";
import type { LLMProvider } from "@spc/llm";
import type { Config, DesiredProperty, RequirementState } from "@spc/schema";
import { gitOk, currentRevision } from "@spc/repo";
import { prepareDisposableWorktree } from "./prepare.js";
import { verifyProperties } from "./verify.js";
import type { EventStore } from "./events.js";
import type { EvidenceStore } from "./stores.js";
import type { FollowupStore } from "./stores.js";

/**
 * The allowDirtyPaths contamination guard, extracted: re-verify dirt-
 * contaminated satisfied properties against the COMMITTED result in a
 * disposable worktree. Prepared with the shared helper - and a guard
 * that cannot prepare does NOT downgrade: an environmental failure is
 * not contamination evidence, and turning it into one would be exactly
 * the misclassification this machinery exists to prevent
 * (verification-preparation, VP-004).
 */
export interface ContaminationGuardInput {
  repoRoot: string;
  runId: string;
  resultRevision: string;
  specProperties: readonly DesiredProperty[];
  config: Config;
  provider: LLMProvider | null;
  evidence: EvidenceStore;
  followups: FollowupStore;
  events: EventStore;
  log: (line: string) => void;
  now?: () => string;
}

export interface ContaminationGuardResult {
  ran: boolean;
  reason?: string;
  states: RequirementState[];
}

export async function runContaminationGuard(input: ContaminationGuardInput): Promise<ContaminationGuardResult> {
  const paths = await import("./paths.js").then((m) => m.spcPaths(input.repoRoot));
  const guardWt = path.join(paths.worktreesDir, `contamination-${input.runId}`);
  try {
    gitOk(input.repoRoot, ["worktree", "remove", "--force", guardWt]);
  } catch {
    /* absent - fine */
  }
  gitOk(input.repoRoot, ["worktree", "add", "--detach", guardWt, input.resultRevision]);
  try {
    const prepared = prepareDisposableWorktree(input.repoRoot, guardWt);
    if (prepared.mode === "failed") {
      return {
        ran: false,
        reason: `preparation failed: ${prepared.detail ?? "environment not installable"} - the observation could not be made; no downgrade (an environmental failure is not contamination evidence)`,
        states: [],
      };
    }
    const guard = await verifyProperties({
      properties: input.specProperties as never,
      runId: input.runId,
      cwd: guardWt,
      revision: currentRevision(guardWt),
      config: input.config,
      provider: input.provider,
      evidence: input.evidence,
      followups: input.followups,
      events: input.events,
      environmentReady: true,
      ...(input.now ? { now: input.now } : {}),
    });
    return { ran: true, states: guard.states };
  } finally {
    try {
      gitOk(input.repoRoot, ["worktree", "remove", "--force", guardWt]);
    } catch {
      /* best effort cleanup */
    }
  }
}
