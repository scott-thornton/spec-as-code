import { describe, expect, it } from "vitest";
import { compileSpecSource } from "@spc/core";
import type { Evidence, FollowUp, RunState } from "@spc/schema";
import { renderDiff, renderStatus } from "./status.js";
import { renderRunSummary } from "./summary.js";
import { renderPlan } from "./plan.js";
import { renderSpecMarkdown } from "./spec.js";

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: oauth-login
  title: GitHub OAuth Authentication
goal: OAuth login works.
requirements:
  - id: AUTH-001
    statement: Users can log in with GitHub OAuth.
    priority: must
    acceptance:
      - id: AUTH-001-A
        type: command
        command: node --test tests/
  - id: AUTH-004
    statement: Login telemetry is recorded.
    priority: should
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

const runState: RunState = {
  runId: "run-abc",
  kind: "apply",
  specId: "oauth-login",
  specDigest: ir.digest,
  status: "partially_satisfied",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T01:00:00.000Z",
  modelCalls: 4,
  replans: 1,
  tasks: {
    T001: { taskId: "T001", status: "completed", attempt: 1 },
    T002: { taskId: "T002", status: "blocked", attempt: 1 },
  },
  requirements: {
    "AUTH-001": {
      propertyId: "AUTH-001",
      status: "satisfied",
      evidenceIds: ["EV-001"],
      updatedAt: "2026-09-17T00:30:00.000Z",
    },
    "AUTH-C01": {
      propertyId: "AUTH-C01",
      status: "indeterminate",
      evidenceIds: ["EV-002"],
      updatedAt: "2026-09-17T00:40:00.000Z",
      reason: "criterion AUTH-C01-A inconclusive",
      weakEvidence: true,
    },
  },
};

const evidence: Evidence[] = [
  {
    id: "EV-001",
    runId: "run-abc",
    criterionId: "AUTH-001-A",
    propertyRefs: ["AUTH-001"],
    kind: "test",
    outcome: "supports",
    producer: { type: "runtime" },
    timestamp: "2026-09-17T00:30:00.000Z",
    repositoryRevision: "r1",
    payload: {},
    digest: `sha256:${"1".repeat(64)}`,
  },
  {
    id: "EV-002",
    runId: "run-abc",
    criterionId: "AUTH-C01-A",
    propertyRefs: ["AUTH-C01"],
    kind: "agent",
    outcome: "supports",
    producer: { type: "agent", identity: "fake" },
    timestamp: "2026-09-17T00:40:00.000Z",
    repositoryRevision: "r1",
    payload: {},
    digest: `sha256:${"2".repeat(64)}`,
  },
];

const followups: FollowUp[] = [
  {
    id: "F-001",
    runId: "run-abc",
    type: "spec_clarification",
    blocking: true,
    title: "Clarify session lifetime",
    description: "d",
    status: "open",
    createdAt: "2026-09-17T00:00:00.000Z",
  },
];

describe("renderers", () => {
  it("status is requirement-oriented with evidence provenance", () => {
    const text = renderStatus({ specIr: ir, runState, followups, evidence });
    expect(text).toContain("Spec: oauth-login");
    expect(text).toContain("MUST");
    expect(text).toContain("✓ AUTH-001");
    expect(text).toContain("? AUTH-C01");
    expect(text).toContain("SHOULD");
    expect(text).toContain("deterministic-test supports");
    expect(text).toContain("agent-review supports");
    expect(text).toContain("Tasks: 1 completed, 1 blocked");
    expect(text).toContain("Follow-ups: 1 blocking");
    expect(text).toContain("F-001 Clarify session lifetime");
  });

  it("status without a run shows unknown states", () => {
    const text = renderStatus({ specIr: ir, runState: null, followups: [], evidence: [] });
    expect(text).toContain("Run: none yet");
    expect(text).toContain("○ AUTH-001");
  });

  it("diff compares desired vs observed", () => {
    const text = renderDiff({ specIr: ir, runState });
    expect(text).toContain("Desired");
    expect(text).toContain("AUTH-001 Users can log in with GitHub OAuth.");
    expect(text).toMatch(/AUTH-001.*satisfied/);
    expect(text).toMatch(/AUTH-004.*unknown/);
  });

  it("run summary markdown includes requirement evidence and remaining risk", () => {
    const text = renderRunSummary({ specIr: ir, runState, followups, evidence, changedFileCount: 3 });
    expect(text).toContain("# Run run-abc");
    expect(text).toContain("1 satisfied");
    expect(text).toContain("**AUTH-001** - satisfied");
    expect(text).toContain("Remaining risk");
    expect(text).toContain("AUTH-C01 verified by non-deterministic evidence only");
    expect(text).toContain("Replans: 1");
  });

  it("plan rendering shows coverage and execution order", () => {
    const plan = {
      apiVersion: "spc.dev/v1alpha1" as const,
      kind: "Plan" as const,
      metadata: { id: "plan-1", createdAt: "now" },
      spec: { id: "oauth-login", digest: ir.digest },
      repository: { revision: "abcdef123456", snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [
        { id: "T001", title: "Implement", kind: "modify" as const, intent: "i", dependsOn: [], satisfies: ["AUTH-001"], targets: { write: ["src/auth.ts"] } },
        { id: "T002", title: "Verify", kind: "verify" as const, intent: "v", dependsOn: ["T001"], verifies: ["AUTH-001"] },
      ],
    };
    const text = renderPlan(plan, ir);
    expect(text).toContain("Plan: plan-1");
    expect(text).toContain("AUTH-001 ✓");
    expect(text).toContain("T001 Implement [modify]");
    expect(text).toContain("T002 Verify [verify]");
    expect(text).toContain("src/auth.ts");
  });

  it("spec markdown renders goal, properties and acceptance", () => {
    const text = renderSpecMarkdown(ir);
    expect(text).toContain("# GitHub OAuth Authentication");
    expect(text).toContain("## Goal");
    expect(text).toContain("AUTH-001");
    expect(text).toContain("node --test tests/");
    expect(text).not.toContain("## Out of scope");
  });
});
