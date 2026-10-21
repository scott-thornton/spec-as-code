import { describe, expect, it } from "vitest";
import { lintSpec, LINT_RULES } from "./commands/lint.js";
import { configSchema } from "@spc/schema";

const DEFAULT_CONFIG = configSchema.parse({});

const ir = {
  spec: { metadata: { id: "prov", title: "t" }, goal: "g", outOfScope: ["x"] },
  properties: [],
  digest: "sha256:" + "0".repeat(64),
} as never;

describe("lint rule provenance (the ratchet's lineage record)", () => {
  it("every active rule carries provenance with BOTH fixtures described", () => {
    expect(LINT_RULES.length).toBeGreaterThanOrEqual(6);
    for (const rule of LINT_RULES) {
      expect(rule.id, `${rule.id} id`).toMatch(/^LINT-[A-Z0-9-]+$/);
      expect(rule.motivation.length, `${rule.id} motivation`).toBeGreaterThan(10);
      expect(rule.negativeFixture.length, `${rule.id} negativeFixture`).toBeGreaterThan(10);
      expect(rule.positiveFixture.length, `${rule.id} positiveFixture`).toBeGreaterThan(10);
      expect(rule.approvedBy.length, `${rule.id} approvedBy`).toBeGreaterThan(0);
      if (rule.supersededBy) expect(rule.supersededBy).toMatch(/^LINT-[A-Z0-9-]+$/);
    }
  });

  it("a superseded rule stays in the registry, marked, and does not fire", () => {
    const superseded = LINT_RULES.find((r) => r.supersededBy);
    expect(superseded).toBeDefined();
    // The original UNPROTECTED-ORACLE rule's narrow form was superseded by
    // its runner-gated version (the slerp FP saga).
    expect(superseded!.id).toBe("LINT-UNPROTECTED-ORACLE-V1");
    // Firing the OLD rule's trigger through lintSpec emits only the
    // current rule id, never the superseded one.
    const irWithCommand = {
      spec: { metadata: { id: "prov2", title: "t" }, goal: "g", outOfScope: ["x"] },
      properties: [{
        kind: "requirement",
        id: "P-001",
        statement: "s.",
        priority: "must",
        dependsOn: [],
        acceptance: [{ id: "P-001-A", type: "command", command: "npx vitest run tests/unit/x.spec.ts" }],
      }],
      digest: "sha256:" + "0".repeat(64),
    } as never;
    const warnings = lintSpec(irWithCommand, DEFAULT_CONFIG);
    const ids = warnings.map((w) => w.rule);
    expect(ids).toContain("LINT-UNPROTECTED-ORACLE");
    expect(ids).not.toContain("LINT-UNPROTECTED-ORACLE-V1");
  });
});
