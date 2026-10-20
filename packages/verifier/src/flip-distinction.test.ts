import { describe, expect, it } from "vitest";
import { evaluateProperty } from "./evaluate.js";
import type { DesiredProperty, Evidence } from "@spc/schema";

const property: DesiredProperty = {
  kind: "requirement",
  id: "FLIP-001",
  statement: "The flip distinction holds.",
  priority: "must",
  dependsOn: [],
  acceptance: [
    { id: "FLIP-001-A", type: "command", command: "vitest run x", discriminating: true },
  ],
} as never;

function evidence(id: string, outcome: "supports" | "contradicts" | "inconclusive", phase?: "red"): Evidence {
  return {
    id,
    runId: "run-x",
    criterionId: "FLIP-001-A",
    propertyRefs: ["FLIP-001"],
    kind: "command",
    outcome,
    producer: { type: "runtime" },
    timestamp: "2026-10-20T00:00:00.000Z",
    repositoryRevision: "rev",
    ...(phase ? { phase } : {}),
    payload: {},
    digest: `sha256:${id}`,
  } as never;
}

describe("red-phase outcome distinction (external review Finding C)", () => {
  it("a contradicted baseline followed by a pass IS a flip", () => {
    const result = evaluateProperty(property, [evidence("EV-1", "contradicts", "red"), evidence("EV-2", "supports")], {
      requireRedPhase: true,
      now: () => "2026-10-20T00:00:00.000Z",
    });
    expect(result.status).toBe("satisfied");
  });

  it("an INCONCLUSIVE baseline followed by a pass is NOT a flip - no red was demonstrated", () => {
    // Field shape: red sweep command denied by policy (inconclusive),
    // final sweep approved and passing. The old code's trailing else
    // treated this as a demonstrated flip.
    const result = evaluateProperty(property, [evidence("EV-1", "inconclusive", "red"), evidence("EV-2", "supports")], {
      requireRedPhase: true,
      now: () => "2026-10-20T00:00:00.000Z",
    });
    expect(result.status).toBe("indeterminate");
    expect(result.reason ?? "").toMatch(/inconclusive|no.*red|baseline/i);
  });
});
