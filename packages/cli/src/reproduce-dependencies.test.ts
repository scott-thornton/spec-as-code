import { describe, expect, it } from "vitest";
import { checkComparability } from "./reproduce-compare.js";

// Oracle for specs/reproduce-verification.yaml REPRO-002 (red,
// committed pre-run): the deep comparability matrix beyond the happy
// path - a convenient current replacement is never silently treated
// as the original dependency. The preflight is a pure function over
// recorded identities, the frozen definitions at the result revision,
// and prerequisite availability; every mismatch is named, never
// swallowed into a green report. The classification half of the
// matrix lives in reproduce-comparison.test.ts.
describe("REPRO-002: dependencies and identities, named per mismatch", () => {
  const base = {
    recordedSpecDigest: "sha256:recorded",
    specDigestAtRevision: "sha256:recorded",
    originalCriteria: ["A-1"],
    frozenCriteria: ["A-1"],
    prerequisites: { node: true, pnpm: true },
  };

  it("a spec that does not compile at the result revision is not-comparable, with the digest reason naming the recorded expectation", () => {
    const r = checkComparability({ ...base, specDigestAtRevision: undefined });
    expect(r.comparable).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/spec.*not compile|unavailable|digest/i);
  });

  it("missing prerequisites each name their tool - no silent substitution by a current environment", () => {
    const both = checkComparability({ ...base, prerequisites: { node: false, pnpm: false } });
    expect(both.comparable).toBe(false);
    expect(both.reasons.join(" ")).toMatch(/node/);
    expect(both.reasons.join(" ")).toMatch(/pnpm/);
  });

  it("every original criterion missing from the frozen definitions is named", () => {
    const r = checkComparability({ ...base, originalCriteria: ["A-1", "B-2", "C-3"], frozenCriteria: ["A-1"] });
    expect(r.comparable).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/B-2/);
    expect(r.reasons.join(" ")).toMatch(/C-3/);
  });
});
