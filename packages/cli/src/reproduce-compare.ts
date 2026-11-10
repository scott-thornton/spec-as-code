import { createHash } from "node:crypto";

/**
 * Reproduction comparison (specs/reproduce-verification, REPRO-002/
 * REPRO-003). Pure classification over two evidence observations - no
 * execution, no IO. The attribution rule carries the session's
 * classification work forward: an infrastructure death, budget
 * timeout, suite non-execution, or admission refusal in the NEW
 * execution is INCONCLUSIVE, never divergence - the machine failing
 * to observe is not the artifact failing to reproduce. Divergence
 * requires two comparable, attributed, opposing outcomes. Absence -
 * a missing record on either side, an unattributed original, or a
 * differing command - is NOT-COMPARABLE, never a verdict.
 */

export type ReproductionVerdict = "reproduced" | "diverged" | "not-comparable" | "inconclusive";

export interface SideEvidence {
  criterionId: string;
  evidenceId?: string;
  outcome?: "supports" | "contradicts" | "inconclusive";
  failureShape?: string;
  command?: string;
}

const INFRA_SHAPES = new Set([
  "budget-timeout",
  "environment-death",
  "admission-refused",
  "admission-deferred",
  "suite-did-not-run",
]);

export function classifyReproduction(original?: SideEvidence, fresh?: SideEvidence): ReproductionVerdict {
  if (original === undefined || fresh === undefined) return "not-comparable";
  if (original.outcome === undefined || original.outcome === "inconclusive") return "not-comparable";
  if (
    typeof original.command === "string" &&
    typeof fresh.command === "string" &&
    original.command !== fresh.command
  ) {
    return "not-comparable";
  }
  if (fresh.outcome === "inconclusive" || INFRA_SHAPES.has(fresh.failureShape ?? "")) return "inconclusive";
  if (original.outcome === fresh.outcome) return "reproduced";
  return "diverged";
}

export interface ComparabilityInput {
  recordedSpecDigest: string;
  /** Digest of the spec compiled at the result revision; undefined
   *  means it does not compile there (or is unresolvable). */
  specDigestAtRevision?: string;
  originalCriteria: string[];
  frozenCriteria: string[];
  prerequisites: { node: boolean; pnpm: boolean };
}

/** The preflight: every mismatch is named - a convenient current
 *  replacement is never silently treated as the original dependency. */
export function checkComparability(input: ComparabilityInput): { comparable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.specDigestAtRevision === undefined) {
    reasons.push(
      `spec does not compile at the result revision; the recorded spec digest ${input.recordedSpecDigest} cannot be matched`,
    );
  } else if (input.specDigestAtRevision !== input.recordedSpecDigest) {
    reasons.push(
      `spec digest changed: the run recorded ${input.recordedSpecDigest}, the result revision carries ${input.specDigestAtRevision}`,
    );
  }
  for (const criterion of input.originalCriteria) {
    if (!input.frozenCriteria.includes(criterion)) {
      reasons.push(`criterion ${criterion} is absent from the frozen spec at the result revision`);
    }
  }
  if (!input.prerequisites.node) reasons.push("node is not available in the execution environment");
  if (!input.prerequisites.pnpm) reasons.push("pnpm is not available in the execution environment");
  return { comparable: reasons.length === 0, reasons };
}

/** The comparison report's command digest - the identity of WHAT ran,
 *  beside the outcome of running it. */
export function commandDigest(command: string): string {
  return "sha256:" + createHash("sha256").update(command, "utf8").digest("hex");
}
