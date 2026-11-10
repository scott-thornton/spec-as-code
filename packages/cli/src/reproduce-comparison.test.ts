import { describe, expect, it } from "vitest";
import { classifyReproduction, checkComparability } from "./reproduce-compare.js";

// Oracle for specs/reproduce-verification.yaml REPRO-003/REPRO-002
// (red, committed pre-run): the comparison distinguishes reproduced,
// diverged, not-comparable, and inconclusive per criterion, and the
// attribution rule carries the session's classification work forward -
// an infrastructure death, budget timeout, suite non-execution, or
// admission refusal in the NEW execution is inconclusive, never
// divergence; the machine failing to observe is not the artifact
// failing to reproduce. Today the module does not exist - this is red.

function side(criterionId: string, outcome: "supports" | "contradicts" | "inconclusive", extra: Partial<Parameters<typeof classifyReproduction>[0]> = {}) {
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
