import { describe, expect, it } from "vitest";
import { classifyReproduction, checkComparability, latestByCriterion } from "./reproduce-compare.js";

// Oracle for specs/reproduce-verification.yaml REPRO-003/REPRO-002
// (red, committed pre-run): the comparison distinguishes reproduced,
// diverged, not-comparable, and inconclusive per criterion, and the
// attribution rule carries the session's classification work forward -
// an infrastructure death, budget timeout, suite non-execution, or
// admission refusal in the NEW execution is inconclusive, never
// divergence; the machine failing to observe is not the artifact
// failing to reproduce. Today the module does not exist - this is red.

function side(criterionId: string, outcome: "supports" | "contradicts" | "inconclusive", extra: Record<string, unknown> = {}) {
  return { criterionId, evidenceId: `ev-${criterionId}`, outcome, ...extra };
}

describe("REPRO-003: the comparison verdicts", () => {
  it("equal attributed outcomes reproduce; opposing attributed outcomes diverge", () => {
    expect(classifyReproduction(side("C-1", "supports"), side("C-1", "supports"))).toBe("reproduced");
    expect(classifyReproduction(side("C-1", "contradicts"), side("C-1", "contradicts"))).toBe("reproduced");
    expect(classifyReproduction(side("C-1", "supports"), side("C-1", "contradicts"))).toBe("diverged");
    expect(classifyReproduction(side("C-1", "contradicts"), side("C-1", "supports"))).toBe("diverged");
  });

  it("infrastructure shapes in the NEW execution are inconclusive, never divergence - all five", () => {
    for (const shape of ["budget-timeout", "environment-death", "admission-refused", "admission-deferred", "suite-did-not-run"]) {
      const verdict = classifyReproduction(side("C-1", "supports"), side("C-1", "contradicts", { failureShape: shape }));
      expect(verdict).toBe("inconclusive");
    }
  });

  it("an inconclusive NEW outcome is inconclusive even without a shape", () => {
    expect(classifyReproduction(side("C-1", "supports"), side("C-1", "inconclusive"))).toBe("inconclusive");
  });

  it("an UNATTRIBUTED original (inconclusive) is not-comparable - divergence needs two attributed outcomes", () => {
    expect(classifyReproduction(side("C-1", "inconclusive"), side("C-1", "supports"))).toBe("not-comparable");
  });

  it("a missing record on either side is not-comparable - identity present, observation absent", () => {
    expect(classifyReproduction(side("C-1", "supports"), undefined)).toBe("not-comparable");
    expect(classifyReproduction(undefined, side("C-1", "supports"))).toBe("not-comparable");
    expect(classifyReproduction(undefined, undefined)).toBe("not-comparable");
  });

  it("differing command digests are not-comparable - the two sides did not run the same criterion", () => {
    const verdict = classifyReproduction(
      side("C-1", "supports", { command: "pnpm test old" }),
      side("C-1", "supports", { command: "pnpm test new" }),
    );
    expect(verdict).toBe("not-comparable");
  });
});

describe("REPRO-002: comparability preflight", () => {
  const base = {
    recordedSpecDigest: "sha256:aaa",
    specDigestAtRevision: "sha256:aaa",
    originalCriteria: ["C-1", "C-2"],
    frozenCriteria: ["C-1", "C-2"],
    prerequisites: { node: true, pnpm: true },
  };

  it("everything matching is comparable; each mismatch names its reason", () => {
    expect(checkComparability(base)).toEqual({ comparable: true, reasons: [] });
    expect(checkComparability({ ...base, specDigestAtRevision: "sha256:bbb" }).comparable).toBe(false);
    expect(checkComparability({ ...base, specDigestAtRevision: "sha256:bbb" }).reasons.join(" ")).toMatch(/spec.*digest|digest.*chang/i);
    expect(checkComparability({ ...base, frozenCriteria: ["C-1"] }).comparable).toBe(false);
    expect(checkComparability({ ...base, frozenCriteria: ["C-1"] }).reasons.join(" ")).toMatch(/C-2/);
    expect(checkComparability({ ...base, prerequisites: { node: false, pnpm: true } }).comparable).toBe(false);
    expect(checkComparability({ ...base, prerequisites: { node: true, pnpm: false } }).reasons.join(" ")).toMatch(/pnpm/);
  });

  it("extra frozen criteria do not block comparison - only missing originals do", () => {
    expect(checkComparability({ ...base, frozenCriteria: ["C-1", "C-2", "C-3"] }).comparable).toBe(true);
  });
});

// Rectification oracles (adversarial pass on run-mwa5bo8b, F1s 1-2 +
// F2s): evidence collapses to the LATEST non-red record per criterion
// (evaluate.ts's own semantics - red-phase records are base-revision
// observations by design), the preflight checks the spec that will
// actually EXECUTE (the current tree), a cache replay is not an
// observation at the result revision, and evidence parsing never
// discards silently. Today these are red.
describe("REPRO-003 rectification: per-criterion, not per-record", () => {
  it("latestByCriterion keeps the LAST non-red record per criterion - red-phase records are base observations, never divergence", () => {
    const rows = latestByCriterion([
      { criterionId: "C-1", outcome: "contradicts", phase: "red" },
      { criterionId: "C-1", outcome: "supports" },
      { criterionId: "C-1", outcome: "supports" },
      { criterionId: "C-2", outcome: "contradicts", phase: "red" },
      { criterionId: "C-2", outcome: "supports" },
    ]);
    expect(rows.size).toBe(2);
    expect(rows.get("C-1")?.outcome).toBe("supports");
    expect(rows.get("C-2")?.outcome).toBe("supports");
  });

  it("a fresh record that is a CACHE REPLAY (reusedFrom) is inconclusive - it observed the current tree, not the result revision", () => {
    const verdict = classifyReproduction(side("C-1", "supports"), side("C-1", "supports", { reusedFrom: "run-other" }));
    expect(verdict).toBe("inconclusive");
  });
});

describe("REPRO-002 rectification: the executing spec is part of comparability", () => {
  const base2 = {
    recordedSpecDigest: "sha256:r",
    specDigestAtRevision: "sha256:r",
    currentSpecDigest: "sha256:r",
    originalCriteria: ["A-1"],
    frozenCriteria: ["A-1"],
    prerequisites: { node: true, pnpm: true },
  };

  it("a CURRENT spec that differs from the recorded one is not-comparable - spec drift must never masquerade as artifact divergence", () => {
    const r = checkComparability({ ...base2, currentSpecDigest: "sha256:current" });
    expect(r.comparable).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/current/i);
  });

  it("an unrecorded digest says so plainly - never 'changed'", () => {
    const r = checkComparability({ ...base2, recordedSpecDigest: undefined as unknown as string });
    expect(r.comparable).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/never recorded|not recorded/i);
  });
});
