import { describe, expect, it } from "vitest";
import { runScheduler, type SchedulerIO } from "./scheduler.js";
import type { Plan, Task, TaskState } from "@spc/schema";

function task(id: string, dependsOn: string[] = []): Task {
  return { id, title: id, kind: "modify", intent: "i", dependsOn };
}
function plan(tasks: Task[]): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "p", createdAt: "now" },
    spec: { id: "s", digest: `sha256:${"0".repeat(64)}` },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks,
  } as Plan;
}
function outcome(taskId: string, status: "completed" | "needs_replan", summary = "") {
  return {
    taskId,
    status,
    summary: summary || "x",
    result: { status, summary: summary || "x", changes: [], commands: [], observations: [], evidenceCandidates: [], followups: [] },
    appliedChanges: [],
  };
}

function io(tasks: Task[], states: Map<string, TaskState>, behavior: (id: string) => "completed" | "needs_replan-amended" | "needs_replan-abandoned"): SchedulerIO {
  return {
    getPlan: () => plan(tasks),
    getTaskState: (id) => states.get(id),
    transition: (id, state) => states.set(id, state),
    execute: async (t) => {
      const b = behavior(t.id);
      if (b === "needs_replan-amended") return outcome(t.id, "needs_replan");
      if (b === "needs_replan-abandoned") return outcome(t.id, "needs_replan");
      return outcome(t.id, "completed");
    },
    onNeedsReplan: async () => (tasks[0] && states.get(tasks[0].id)?.status === "needs_replan" && behavior(tasks[0].id) === "needs_replan-amended" ? "amended" : "amended"),
    maxTaskRetries: 0,
  };
}

describe("the conclusion guard", () => {
  it("refuses to conclude while a plan task sits in a non-terminal state - the run fails loudly", async () => {
    const tasks = [task("T001"), task("T002", ["T001"])];
    const states = new Map<string, TaskState>([
      ["T001", { taskId: "T001", status: "needs_replan", attempt: 1 }],
      ["T002", { taskId: "T002", status: "blocked", attempt: 0 }],
    ]);
    // The amendment "succeeds" but nothing resets T001 - the pre-fix
    // CHK3555 shape. The scheduler must not conclude done over it.
    const result = await runScheduler(io(tasks, states, () => "needs_replan-amended"));
    expect(result.outcome).not.toBe("done");
    expect(result.outcome).toBe("runnable_work_remains");
  });

  it("all terminal states conclude normally", async () => {
    const tasks = [task("T001"), task("T002", ["T001"])];
    const states = new Map<string, TaskState>();
    const result = await runScheduler({
      ...io(tasks, states, () => "completed"),
    });
    expect(result.outcome).toBe("done");
  });
});
