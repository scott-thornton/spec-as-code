import { describe, expect, it } from "vitest";
import { compileSpecSource } from "@spc/core";
import type { Plan, RepositorySnapshot, TaskState } from "@spc/schema";
import type { LLMProvider, StructuredRequest, StructuredResponse } from "@spc/llm";
import { generatePlan } from "./planner.js";
import { generateAmendment } from "./amendment.js";

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: greeting-api
  title: Greeting API
goal: Greeting works.
requirements:
  - id: GREETING-001
    statement: Calling greeting returns "hello".
    priority: must
    acceptance:
      - id: GREETING-001-A
        type: command
        command: node --test tests/
`;
const specIr = compileSpecSource(specYaml, "specs/greeting.yaml").ir!;

const snapshot: RepositorySnapshot = {
  revision: "rev000",
  dirty: false,
  languages: ["javascript"],
  manifests: [{ path: "package.json", kind: "npm", name: "greeting" }],
  directories: [],
  tests: [{ path: "tests/greeting.test.mjs" }],
  commands: { test: "npm test" },
  relevantArtifacts: [{ path: "tests/greeting.test.mjs", reason: "matches greeting" }],
  createdAt: "2026-09-17T00:00:00.000Z",
  digest: `sha256:${"0".repeat(64)}`,
};

const goodPlannerOutput = {
  plan: {
    tasks: [
      {
        id: "T001",
        title: "Implement greeting",
        kind: "modify",
        intent: "create the greeting function",
        dependsOn: [],
        satisfies: ["GREETING-001"],
        targets: { read: ["tests/**"], write: ["src/greeting.mjs"] },
      },
      {
        id: "T002",
        title: "Verify greeting",
        kind: "verify",
        intent: "run acceptance",
        dependsOn: ["T001"],
        verifies: ["GREETING-001"],
      },
    ],
  },
  observations: [],
  assumptions: ["tests run with node --test"],
  followups: [],
};

/** Scripted inline provider: sequential values per role. */
function scripted(script: { planner?: unknown[]; replanner?: unknown[] }): LLMProvider {
  const idx: Record<string, number> = { planner: 0, replanner: 0 };
  return {
    name: "scripted-test",
    model: "test",
    async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
      const list = (script as Record<string, unknown[] | undefined>)[request.role] ?? [];
      const i = idx[request.role] ?? 0;
      const value = list[i] ?? list[list.length - 1];
      idx[request.role] = i + 1;
      if (value === undefined) throw new Error(`no scripted value for role ${request.role}`);
      return { value: value as T, usage: { model: "test", durationMs: 0 } };
    },
  };
}

describe("plan generation", () => {
  it("produces a normalized, validated plan on the first attempt", async () => {
    const r = await generatePlan({
      specIr,
      snapshot,
      excerpts: [],
      provider: scripted({ planner: [goodPlannerOutput] }),
      planId: "plan-20260917-001",
    });
    expect(r.attempts).toBe(1);
    expect(r.plan).not.toBeNull();
    expect(r.plan!.tasks.map((t) => t.id)).toEqual(["T001", "T002"]);
    expect(r.plan!.spec.digest).toBe(specIr.digest);
    expect(r.plan!.repository.snapshotDigest).toBe(snapshot.digest);
    expect(r.plan!.assumptions).toEqual(["tests run with node --test"]);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("repairs an invalid plan using validation diagnostics", async () => {
    const bad = {
      plan: {
        tasks: [
          // Missing verification path and coverage: GREETING-001 only satisfied, no verify,
          // but it has a command criterion so only coverage matters - make it worse: unknown property.
          {
            id: "T001",
            title: "Wrong",
            kind: "modify",
            intent: "references unknown property",
            dependsOn: ["T999"],
            satisfies: ["NOPE-1"],
            targets: { write: ["../outside.ts"] },
          },
        ],
      },
    };
    const r = await generatePlan({
      specIr,
      snapshot,
      excerpts: [],
      provider: scripted({ planner: [bad, goodPlannerOutput] }),
      planId: "plan-x",
    });
    expect(r.attempts).toBe(2);
    expect(r.plan).not.toBeNull();
    expect(r.plan!.tasks[0]?.satisfies).toEqual(["GREETING-001"]);
  });

  it("fails visibly after exhausting repair attempts", async () => {
    const r = await generatePlan({
      specIr,
      snapshot,
      excerpts: [],
      provider: scripted({ planner: [{ plan: { tasks: [] } }] }),
      planId: "plan-x",
    });
    expect(r.plan).toBeNull();
    expect(r.attempts).toBe(3);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("amendment generation", () => {
  const basePlan: Plan = {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-base", createdAt: "now" },
    spec: { id: specIr.spec.metadata.id, digest: specIr.digest },
    repository: { revision: snapshot.revision, snapshotDigest: snapshot.digest },
    tasks: [
      {
        id: "T001",
        title: "Implement greeting",
        kind: "modify",
        intent: "i",
        dependsOn: [],
        satisfies: ["GREETING-001"],
        targets: { write: ["src/greeting.mjs"] },
      },
      {
        id: "T002",
        title: "Verify",
        kind: "verify",
        intent: "v",
        dependsOn: ["T001"],
        verifies: ["GREETING-001"],
      },
    ],
  };

  const observation = {
    id: "OBS-001",
    runId: "run-1",
    taskId: "T001",
    type: "architecture" as const,
    statement: "Implementation lives in packages/security, not src/auth.",
    confidence: "confirmed" as const,
    invalidates: { taskIds: ["T001"] },
  };

  const goodAmendment = {
    reason: "wrong target location",
    operations: [
      {
        op: "replaceTask" as const,
        taskId: "T001",
        task: {
          id: "T003",
          title: "Implement greeting at correct location",
          kind: "modify" as const,
          intent: "i",
          dependsOn: [],
          satisfies: ["GREETING-001"],
          targets: { write: ["src/greeting.mjs"] },
        },
      },
    ],
  };

  it("generates, validates and applies amendments preserving dependents", async () => {
    const states = new Map<string, TaskState>([
      ["T001", { taskId: "T001", status: "needs_replan", attempt: 1 }],
      ["T002", { taskId: "T002", status: "pending", attempt: 0 }],
    ]);
    const r = await generateAmendment({
      specIr,
      plan: basePlan,
      taskStates: states,
      executedTaskIds: [],
      triggeringObservations: [observation],
      provider: scripted({ replanner: [goodAmendment] }),
      amendmentId: "AM-001",
    });
    expect(r.amendment).not.toBeNull();
    expect(r.amendedPlan).not.toBeNull();
    expect(r.amendedPlan!.tasks.map((t) => t.id).sort()).toEqual(["T002", "T003"]);
    expect(r.amendedPlan!.tasks.find((t) => t.id === "T002")?.dependsOn).toEqual(["T003"]);
  });

  it("rejects amendments touching executed tasks and repairs on the next attempt", async () => {
    const bad = {
      reason: "touch completed",
      operations: [{ op: "removeTask", taskId: "T002" }],
    };
    const states = new Map<string, TaskState>([
      ["T002", { taskId: "T002", status: "completed", attempt: 1 }],
    ]);
    const r = await generateAmendment({
      specIr,
      plan: basePlan,
      taskStates: states,
      executedTaskIds: ["T002"],
      triggeringObservations: [observation],
      provider: scripted({ replanner: [bad, goodAmendment] }),
      amendmentId: "AM-001",
    });
    expect(r.attempts).toBe(2);
    expect(r.amendedPlan).not.toBeNull();
  });

  it("fails visibly when repairs cannot fix the amendment", async () => {
    const bad = {
      reason: "always wrong",
      operations: [{ op: "removeTask", taskId: "T002" }],
    };
    const r = await generateAmendment({
      specIr,
      plan: basePlan,
      taskStates: new Map([["T002", { taskId: "T002", status: "completed", attempt: 1 }]]),
      executedTaskIds: ["T002"],
      triggeringObservations: [observation],
      provider: scripted({ replanner: [bad] }),
      amendmentId: "AM-001",
    });
    expect(r.amendment).toBeNull();
    expect(r.amendedPlan).toBeNull();
    expect(r.diagnostics.some((d) => d.code === "SPC2013")).toBe(true);
  });
});
