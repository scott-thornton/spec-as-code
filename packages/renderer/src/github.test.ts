import { describe, expect, it } from "vitest";
import { compileSpecSource } from "@spc/core";
import type { RequirementState } from "@spc/schema";
import { renderGithubAnnotations, renderGithubSummary } from "./github.js";

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: oauth-login
  title: OAuth
goal: OAuth works.
requirements:
  - id: AUTH-001
    statement: OAuth login works.
    priority: must
    acceptance:
      - id: AUTH-001-A
        type: command
        command: node --test "tests/*.test.mjs"
  - id: AUTH-002
    statement: Telemetry is recorded.
    priority: should
    acceptance:
      - id: AUTH-002-A
        type: file
        path: src/telemetry.mjs
        assert:
          exists: true
constraints:
  - id: AUTH-C01
    statement: No plaintext tokens.
    priority: must
    acceptance:
      - id: AUTH-C01-A
        type: agent
        instruction: Inspect persistence.
`;
const ir = compileSpecSource(specYaml, "specs/auth.yaml").ir!;

function state(propertyId: string, status: RequirementState["status"], reason?: string): RequirementState {
  return { propertyId, status, evidenceIds: ["EV-0001"], updatedAt: "now", ...(reason ? { reason } : {}) };
}

describe("github format", () => {
  it("emits error annotations for unsatisfied musts and warnings otherwise", () => {
    const lines = renderGithubAnnotations(ir, [
      state("AUTH-001", "unsatisfied", "criterion AUTH-001-A contradicted"),
      state("AUTH-002", "unsatisfied"),
      state("AUTH-C01", "indeterminate"),
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("::error title=");
    expect(lines[0]).toContain("AUTH-001");
    expect(lines[1]).toContain("::warning title=");
    expect(lines[2]).toContain("::warning title=");
  });

  it("emits no annotations when everything is satisfied or waived", () => {
    expect(renderGithubAnnotations(ir, [state("AUTH-001", "satisfied"), state("AUTH-C01", "waived")])).toEqual([]);
  });

  it("renders a step-summary markdown table", () => {
    const summary = renderGithubSummary({
      specIr: ir,
      states: [state("AUTH-001", "unsatisfied"), state("AUTH-002", "satisfied"), state("AUTH-C01", "indeterminate")],
      runId: "v-run-1",
    });
    expect(summary).toContain("### spc verification - oauth-login");
    expect(summary).toContain("| AUTH-001 | must | unsatisfied | 1 record(s) |");
    expect(summary).toContain("1 unsatisfied, 1 indeterminate");
  });
});
