import { describe, expect, it } from "vitest";
import { compileSpecSource } from "@spc/core";
import type { Evidence, FollowUp, RunState } from "@spc/schema";
import { renderPrDraft } from "./pr.js";

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: greeting-api
  title: Greeting API
goal: Greet.
requirements:
  - id: GREETING-001
    statement: Greeting works.
    priority: must
    acceptance:
      - id: GREETING-001-A
        type: command
        command: node --test "tests/*.test.mjs"
constraints:
  - id: GREETING-C01
    statement: No plaintext tokens.
    priority: must
    acceptance:
      - id: GREETING-C01-A
        type: agent
        instruction: Inspect.
`;
const ir = compileSpecSource(specYaml, "specs/greeting.yaml").ir!;

const runState: RunState = {
  runId: "run-1",
  kind: "apply",
  specId: "greeting-api",
  specDigest: ir.digest,
  planId: "plan-1",
  status: "partially_satisfied",
  branch: "spc/greeting-api/run-1",
  createdAt: "now",
  updatedAt: "now",
  modelCalls: 3,
  replans: 0,
  tasks: { T001: { taskId: "T001", status: "completed", attempt: 1 } },
  requirements: {
    "GREETING-001": { propertyId: "GREETING-001", status: "satisfied", evidenceIds: ["EV-0001"], updatedAt: "now" },
    "GREETING-C01": { propertyId: "GREETING-C01", status: "indeterminate", evidenceIds: ["EV-0002"], updatedAt: "now", weakEvidence: true },
  },
};

const evidence: Evidence[] = [
  { id: "EV-0001", runId: "run-1", criterionId: "GREETING-001-A", propertyRefs: ["GREETING-001"], kind: "test", outcome: "supports", producer: { type: "runtime" }, timestamp: "now", repositoryRevision: "r", payload: {}, digest: "d" },
  { id: "EV-0002", runId: "run-1", criterionId: "GREETING-C01-A", propertyRefs: ["GREETING-C01"], kind: "agent", outcome: "supports", producer: { type: "agent" }, timestamp: "now", repositoryRevision: "r", payload: {}, digest: "d" },
];

const followups: FollowUp[] = [
  { id: "F-001", runId: "run-1", type: "manual_verification", blocking: false, title: "Review UX", description: "d", status: "open", createdAt: "now" },
];

describe("PR generation (§82)", () => {
  it("renders title, requirement table with evidence provenance, verification counts and limitations", () => {
    const draft = renderPrDraft({ specIr: ir, runState, followups, evidence, diffStat: " src/a.mjs | 2 +-\n" });
    expect(draft.title).toContain("spc: Greeting API");
    expect(draft.title).toContain("(1/2 properties satisfied)");
    expect(draft.body).toContain("| GREETING-001 | must | satisfied | deterministic-test:supports |");
    expect(draft.body).toContain("## Verification");
    expect(draft.body).toContain("1 deterministic command/test evidence records");
    expect(draft.body).toContain("## Open follow-ups");
    expect(draft.body).toContain("F-001: Review UX");
    expect(draft.body).toContain("## Known limitations");
    expect(draft.body).toContain("GREETING-C01 is verified by non-deterministic evidence only.");
    expect(draft.body).toContain("review the diff, not this summary");
  });
});
