/**
 * Challenge outcome classification (specs/criterion-challenge,
 * CHAL-002/CHAL-003). Four outcomes; the attribution discipline: a
 * nonzero exit alone never counts as discrimination. An
 * infrastructure-shaped observation (budget-timeout,
 * environment-death, admission-refused) or a missing signature makes
 * the leg inconclusive - the verifier failing to OBSERVE is not the
 * verifier failing to REJECT.
 */

export type ChallengeLegOutcome = "supports" | "contradicts" | "inconclusive";

export interface ChallengeClassificationInput {
  /** The pristine baseline observation. */
  baseline: ChallengeLegOutcome;
  /** The mutated artifact observation. */
  mutation: ChallengeLegOutcome;
  /** The expected failure signature appeared in the mutated
   *  pipeline's captured output. */
  signaturePresent: boolean;
  /** The expected signature ALSO appeared in the BASELINE pipeline's
   *  captured output - a token present in both worlds attributes
   *  nothing; it distinguishes nothing (CHAL-003's enumeration).
   *  Optional: legacy callers that predate the field keep
   *  undefined = not-present-in-baseline semantics. */
  signatureInBaseline?: boolean;
  /** The baseline evidence's failureShape, when it carried one. */
  baselineShape?: string;
  /** The mutation evidence's failureShape, when it carried one. */
  mutationShape?: string;
}

export type ChallengeOutcome = "discriminating" | "non-discriminating" | "invalid-baseline" | "inconclusive";

const INFRA_SHAPES = new Set([
  "budget-timeout",
  "environment-death",
  "admission-refused",
  "admission-deferred",
  // suite-did-not-run rides here as an OVERRIDE: the criteria executor
  // keeps that shape red-capable BY DESIGN in ordinary verification (a
  // suite that cannot load because the implementation is absent IS the
  // red state); a challenge leg carrying it means the suite never ran,
  // and detection power cannot be claimed over prepare build noise.
  "suite-did-not-run",
]);

export function classifyChallenge(input: ChallengeClassificationInput): ChallengeOutcome {
  // Any inconclusive LEG makes the whole challenge inconclusive -
  // infrastructure noise on either side proves nothing (CHAL-C01:
  // admission refusions ride the same rule).
  if (input.baseline === "inconclusive" || INFRA_SHAPES.has(input.baselineShape ?? "")) return "inconclusive";
  if (input.mutation === "inconclusive" || INFRA_SHAPES.has(input.mutationShape ?? "")) return "inconclusive";

  // The pristine artifact must satisfy the criterion - a challenge
  // against an already-red baseline proves nothing about the
  // criterion's detection power.
  if (input.baseline !== "supports") return "invalid-baseline";

  // The mutation was accepted: the verifier failed to reject a known
  // defect.
  if (input.mutation === "supports") return "non-discriminating";

  // Contradicted: discrimination requires the expected signature -
  // an unrelated failure is inconclusive, never a counted detection.
  // And the signature must be attributable to the injected defect: a
  // token the BASELINE pipeline also produced cannot carry the
  // attribution (a loose filename, a common diagnostic code echoed in
  // both payloads) - it does not distinguish the worlds.
  if (input.signatureInBaseline) return "inconclusive";
  return input.signaturePresent ? "discriminating" : "inconclusive";
}
