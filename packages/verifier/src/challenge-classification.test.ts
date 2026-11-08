import { describe, expect, it } from "vitest";
import { classifyChallenge } from "./challenge-classify.js";

// Oracle for specs/criterion-challenge.yaml CHAL-002/CHAL-003 (red,
// committed pre-run): the four-outcome classification with
// attributable-failure discipline. A nonzero exit alone never counts;
// infrastructure shapes and missing signatures are inconclusive. Today
// no classifier exists.
describe("CHAL-002/CHAL-003: challenge outcome classification", () => {
  it("discriminating: valid baseline supports AND the mutation fails with the expected signature in the pipeline output", () => {
    const r = classifyChallenge({
      baseline: "supports",
      mutation: "contradicts",
      signaturePresent: true,
    });
    expect(r).toBe("discriminating");
  });

  it("non-discriminating: the mutated artifact was accepted (the verifier failed to reject a known defect)", () => {
    const r = classifyChallenge({ baseline: "supports", mutation: "supports", signaturePresent: false });
    expect(r).toBe("non-discriminating");
  });

  it("invalid-baseline: the pristine artifact did not satisfy the criterion - nothing is proven about the criterion", () => {
    const r = classifyChallenge({ baseline: "contradicts", mutation: "contradicts", signaturePresent: true });
    expect(r).toBe("invalid-baseline");
  });

  it("inconclusive: a failing mutation WITHOUT the signature is an unrelated failure - never discrimination (CHAL-003)", () => {
    const r = classifyChallenge({ baseline: "supports", mutation: "contradicts", signaturePresent: false });
    expect(r).toBe("inconclusive");
  });

  it("inconclusive: infrastructure-shaped mutation outcomes (timeout, env-death, admission-refused) never discriminate regardless of signature", () => {
    expect(classifyChallenge({ baseline: "supports", mutation: "inconclusive", mutationShape: "budget-timeout", signaturePresent: true })).toBe("inconclusive");
    expect(classifyChallenge({ baseline: "supports", mutation: "inconclusive", mutationShape: "environment-death", signaturePresent: true })).toBe("inconclusive");
    expect(classifyChallenge({ baseline: "supports", mutation: "inconclusive", mutationShape: "admission-refused", signaturePresent: false })).toBe("inconclusive");
  });

  it("inconclusive: an inconclusive baseline (admission/infra) proves nothing either way", () => {
    expect(classifyChallenge({ baseline: "inconclusive", mutation: "contradicts", signaturePresent: true })).toBe("inconclusive");
  });

  // Rectification oracle (adversarial pass, 2026-11-08): CHAL-003
  // enumerates suite-did-not-run in the inconclusive family, and the
  // criteria executor keeps that shape red-capable BY DESIGN in
  // ordinary verification (criteria.ts - a suite that cannot load
  // because the implementation is absent IS the red state). The
  // challenge classifier must override that for detection-power
  // claims: a CONTRADICTED leg carrying the shape means the suite
  // never ran, and a signature matched against prepare build noise
  // (the module-import deletion scenario) must not count as
  // discrimination. Today the classifier accepts it - this is red.
  it("inconclusive: a CONTRADICTED mutation leg shaped suite-did-not-run never discriminates, even with the signature present (CHAL-003)", () => {
    const r = classifyChallenge({
      baseline: "supports",
      mutation: "contradicts",
      mutationShape: "suite-did-not-run",
      signaturePresent: true,
    });
    expect(r).toBe("inconclusive");
  });

  it("pins: contradicted legs carrying the OTHER infra shapes stay inconclusive (the gate is shape-based, not outcome-based)", () => {
    expect(classifyChallenge({ baseline: "supports", mutation: "contradicts", mutationShape: "budget-timeout", signaturePresent: true })).toBe("inconclusive");
    expect(classifyChallenge({ baseline: "supports", mutation: "contradicts", mutationShape: "environment-death", signaturePresent: true })).toBe("inconclusive");
    expect(classifyChallenge({ baseline: "supports", mutation: "contradicts", mutationShape: "admission-refused", signaturePresent: true })).toBe("inconclusive");
    expect(classifyChallenge({ baseline: "supports", mutation: "contradicts", mutationShape: "admission-deferred", signaturePresent: true })).toBe("inconclusive");
    expect(classifyChallenge({ baseline: "contradicts", baselineShape: "suite-did-not-run", mutation: "contradicts", signaturePresent: true })).toBe("inconclusive");
  });
});
