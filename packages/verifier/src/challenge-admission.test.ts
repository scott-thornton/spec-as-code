import { describe, expect, it } from "vitest";
import { classifyChallenge } from "./challenge-classify.js";

// Oracle for specs/criterion-challenge.yaml CHAL-C01-A (red,
// committed pre-run): challenge execution rides the host-battery
// admission machinery by CONSTRUCTION - its criteria execute through
// the criteria executor, so a refused challenge leg is
// admission-refused inconclusive (never an unguarded battery run).
// The classification layer surfaces this; the engine inherits it.
describe("CHAL-C01: challenge rides admission (no unguarded battery path)", () => {
  it("an admission-refused mutation leg classifies inconclusive - never discrimination, never an unguarded run", () => {
    const r = classifyChallenge({
      baseline: "supports",
      mutation: "inconclusive",
      mutationShape: "admission-refused",
      signaturePresent: false,
    });
    expect(r).toBe("inconclusive");
  });

  it("an admission-refused baseline leg classifies inconclusive - the challenge proves nothing", () => {
    const r = classifyChallenge({
      baseline: "inconclusive",
      baselineShape: "admission-refused",
      mutation: "contradicts",
      signaturePresent: true,
    });
    expect(r).toBe("inconclusive");
  });
});
