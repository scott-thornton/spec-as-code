import { describe, expect, it } from "vitest";
import { evaluateProperty } from "@spc/verifier";
import { adoptAncestorFlips } from "./apply.js";

// Oracle for specs/oracle-validity.yaml (OV-003 runtime consumers,
// OV-004 positive control): one eligibility semantics everywhere - the
// live evaluator and the ancestor reconstruction refuse oracle-invalid
// reds, including legacy records carrying the envelope without the
// stamp, while legitimate reds keep establishing flips.

const property = {
  id: "OVE-001",
  statement: "Marker exists.",
  priority: "must",
  acceptance: [{ id: "OVE-001-A", type: "command", command: "vitest run src/marker.test.ts", discriminating: true }],
} as never;

const ev = (phase: "red" | undefined, outcome: string, payload: Record<string, unknown>) =>
  ({
    id: `EV-${Math.random().toString(36).slice(2, 8)}`,
    runId: "r1",
    criterionId: "OVE-001-A",
    propertyRefs: ["OVE-001"],
    kind: "command",
    outcome,
    producer: { type: "runtime" },
    timestamp: phase === "red" ? "2026-10-25T00:00:00.000Z" : "2026-10-25T00:01:00.000Z",
    repositoryRevision: "0".repeat(40),
    ...(phase ? { phase } : {}),
    payload,
    digest: "sha256:0",
  }) as never;

const invalidEnvelope = `Transform failed with 1 error:
/repo/src/marker.test.ts:9:13: ERROR: Expected "}" but found "-"
`;

describe("live evaluator eligibility (OV-003)", () => {
  it("a stamped-invalid baseline red does not establish a flip", () => {
    const evidence = [
      ev("red", "contradicts", { command: "vitest run src/marker.test.ts", oracleValidity: "invalid" }),
      ev(undefined, "supports", { command: "vitest run src/marker.test.ts" }),
    ];
    const state = evaluateProperty(property, evidence, { requireRedPhase: true, allowAgentOnly: false, now: () => "t" } as never);
    expect(state.status).toBe("indeterminate");
    expect(state.reason ?? "").toMatch(/no red was demonstrated|entitled|eligib/i);
  });

  it("a legacy invalid-envelope red (no stamp) is refused BY DERIVATION", () => {
    const evidence = [
      ev("red", "contradicts", { command: "vitest run src/marker.test.ts", stderr: invalidEnvelope }),
      ev(undefined, "supports", { command: "vitest run src/marker.test.ts" }),
    ];
    const state = evaluateProperty(property, evidence, { requireRedPhase: true, allowAgentOnly: false, now: () => "t" } as never);
    expect(state.status).toBe("indeterminate");
  });

  it("an eligible assertion red still establishes the flip - the control (OV-004)", () => {
    const evidence = [
      ev("red", "contradicts", { command: "vitest run src/marker.test.ts", stderr: "AssertionError: expected 1 to be 2" }),
      ev(undefined, "supports", { command: "vitest run src/marker.test.ts" }),
    ];
    const state = evaluateProperty(property, evidence, { requireRedPhase: true, allowAgentOnly: false, now: () => "t" } as never);
    expect(state.status).toBe("satisfied");
  });

  it("a missing-implementation red (the module-import oracle pattern) still flips (OV-004)", () => {
    const evidence = [
      ev("red", "contradicts", {
        command: "vitest run src/marker.test.ts",
        stderr: "Error: Cannot find module '/repo/src/implementation.ts'",
      }),
      ev(undefined, "supports", { command: "vitest run src/marker.test.ts" }),
    ];
    const state = evaluateProperty(property, evidence, { requireRedPhase: true, allowAgentOnly: false, now: () => "t" } as never);
    expect(state.status).toBe("satisfied");
  });
});

describe("ancestor flip adoption eligibility (OV-003)", () => {
  const green = ev(undefined, "supports", { command: "vitest run src/marker.test.ts" });

  it("an ancestor red that is stamped oracle-invalid is never adopted", () => {
    const flips = new Map<string, string>();
    adoptAncestorFlips(
      [ev("red", "contradicts", { command: "vitest run src/marker.test.ts", oracleValidity: "invalid" }), green],
      "run-prior",
      flips,
    );
    expect(flips.size).toBe(0);
  });

  it("a legacy ancestor red carrying the invalid envelope is never adopted (derived at consumption)", () => {
    const flips = new Map<string, string>();
    adoptAncestorFlips(
      [ev("red", "contradicts", { command: "vitest run src/marker.test.ts", stderr: invalidEnvelope }), green],
      "run-prior",
      flips,
    );
    expect(flips.size).toBe(0);
  });

  it("an eligible ancestor red is adopted - inheritance keeps working (OV-004)", () => {
    const flips = new Map<string, string>();
    adoptAncestorFlips(
      [ev("red", "contradicts", { command: "vitest run src/marker.test.ts", stderr: "AssertionError" }), green],
      "run-prior",
      flips,
    );
    expect(flips.get("OVE-001-A")).toBe("run-prior");
  });
});
