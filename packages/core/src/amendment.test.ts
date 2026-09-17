import { describe, expect, it } from "vitest";
import type { Plan, PlanAmendment, Task } from "@spc/schema";
import { applyPlanAmendment } from "./amendment/apply.js";

function task(id: string, dependsOn: string[] = [], write: string[] = []): Task {
  return {
    id,
    title: `Task ${id}`,
    kind: "modify",
    intent: `intent ${id}`,
    dependsOn,
    ...(write.length ? { targets: { write } } : {}),
  };
}

function plan(tasks: Task[]): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-amend", createdAt: "2026-09-17T00:00:00.000Z" },
    spec: { id: "demo", digest: `sha256:${"0".repeat(64)}` },
    repository: { revision: "abc", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks,
  };
}

function amendment(operations: PlanAmendment["operations"]): PlanAmendment {
  return {
    id: "AM-001",
    planId: "plan-amend",
    reason: "discovered actual location",
    observationRefs: ["OBS-001"],
    operations,
    createdAt: "2026-09-17T00:00:00.000Z",
  };
}

describe("plan amendments", () => {
  it("addTask inserts a new task", () => {
    const r = applyPlanAmendment(plan([task("T001")]), amendment([{ op: "addTask", task: task("T002") }]), []);
    expect(r.plan!.tasks.map((t) => t.id)).toEqual(["T001", "T002"]);
  });

  it("removeTask drops the task and its incoming edges", () => {
    const r = applyPlanAmendment(
      plan([task("T001"), task("T002", ["T001"])]),
      amendment([{ op: "removeTask", taskId: "T001" }]),
      [],
    );
    expect(r.plan!.tasks.map((t) => t.id)).toEqual(["T002"]);
    expect(r.plan!.tasks[0]?.dependsOn).toEqual([]);
  });

  it("removeTask of an executed task is rejected (history preserved)", () => {
    const r = applyPlanAmendment(
      plan([task("T001"), task("T002", ["T001"])]),
      amendment([{ op: "removeTask", taskId: "T001" }]),
      ["T001"],
    );
    expect(r.plan).toBeNull();
    expect(r.diagnostics.some((d) => d.code === "SPC2013")).toBe(true);
  });

  it("replaceTask with a new id repoints dependents to the replacement", () => {
    const replacement = task("T005", [], ["packages/security/session.ts"]);
    const r = applyPlanAmendment(
      plan([task("T001", [], ["src/auth/session.ts"]), task("T002", ["T001"])]),
      amendment([{ op: "replaceTask", taskId: "T001", task: replacement }]),
      [],
    );
    expect(r.plan!.tasks.map((t) => t.id).sort()).toEqual(["T002", "T005"]);
    const dep = r.plan!.tasks.find((t) => t.id === "T002")!;
    expect(dep.dependsOn).toEqual(["T005"]);
  });

  it("replaceTask of an executed task is rejected", () => {
    const r = applyPlanAmendment(
      plan([task("T001")]),
      amendment([{ op: "replaceTask", taskId: "T001", task: task("T009") }]),
      ["T001"],
    );
    expect(r.plan).toBeNull();
    expect(r.diagnostics.some((d) => d.code === "SPC2013")).toBe(true);
  });

  it("addDependency adds an edge and rejects cycles", () => {
    const ok = applyPlanAmendment(
      plan([task("T001"), task("T002", ["T001"])]),
      amendment([{ op: "addDependency", taskId: "T002", dependsOnTaskId: "T001" }]),
      [],
    );
    expect(ok.plan!.tasks.find((t) => t.id === "T002")?.dependsOn).toEqual(["T001"]);

    const cyc = applyPlanAmendment(
      plan([task("T001"), task("T002", ["T001"])]),
      amendment([{ op: "addDependency", taskId: "T001", dependsOnTaskId: "T002" }]),
      [],
    );
    expect(cyc.plan).toBeNull();
    expect(cyc.diagnostics.some((d) => d.code === "SPC2015")).toBe(true);
  });

  it("changeTarget updates targets of an unexecuted task only", () => {
    const r = applyPlanAmendment(
      plan([task("T001", [], ["src/a.ts"])]),
      amendment([{ op: "changeTarget", taskId: "T001", targets: { write: ["src/b.ts"] } }]),
      [],
    );
    expect(r.plan!.tasks[0]?.targets?.write).toEqual(["src/b.ts"]);

    const bad = applyPlanAmendment(
      plan([task("T001", [], ["src/a.ts"])]),
      amendment([{ op: "changeTarget", taskId: "T001", targets: { write: ["src/b.ts"] } }]),
      ["T001"],
    );
    expect(bad.plan).toBeNull();
  });

  it("duplicate addTask is rejected", () => {
    const r = applyPlanAmendment(
      plan([task("T001")]),
      amendment([{ op: "addTask", task: task("T001") }]),
      [],
    );
    expect(r.plan).toBeNull();
    expect(r.diagnostics.some((d) => d.code === "SPC2014")).toBe(true);
  });
});
