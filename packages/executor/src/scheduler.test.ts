import { describe, expect, it } from "vitest";
import type { Plan, Task, TaskState } from "@spc/schema";
import { runScheduler, type SchedulerIO } from "./scheduler.js";
import type { ExecutionOutcome } from "./execute.js";

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
  };
}

function outcome(taskId: string, status: ExecutionOutcome["status"], summary = ""): ExecutionOutcome {
  return {
    taskId,
    status,
    summary,
    result: { status, summary: summary || "x", changes: [], observations: [], evidenceCandidates: [], followups: [] },
    appliedChanges: [],
  };
}

interface Harness {
  io: SchedulerIO;
  states: Map<string, TaskState>;
  order: string[];
  log: string[];
}

function harness(
  tasks: Task[],
  behavior: (taskId: string, attempt: number) => ExecutionOutcome | "needs_replan_amend",
  opts: { maxTaskRetries?: number } = {},
): Harness {
  const states = new Map<string, TaskState>();
  const order: string[] = [];
  const log: string[] = [];
  let currentPlan = plan(tasks);
  const io: SchedulerIO = {
    getPlan: () => currentPlan,
    getTaskState: (id) => states.get(id),
    transition: (id, state) => {
      states.set(id, state);
      log.push(`${id}:${state.status}`);
    },
    execute: async (t, attempt) => {
      order.push(`${t.id}@${attempt}`);
      const r = behavior(t.id, attempt);
      if (r === "needs_replan_amend") return outcome(t.id, "needs_replan");
      return r;
    },
    onNeedsReplan: async () => {
      log.push("replan");
      return "amended";
    },
    maxTaskRetries: opts.maxTaskRetries ?? 0,
  };
  return { io, states, order, log };
}

describe("sequential DAG scheduler", () => {
  it("executes tasks in dependency order", async () => {
    const h = harness([task("T002", ["T001"]), task("T001"), task("T003", ["T002"])], (id) =>
      outcome(id, "completed"),
    );
    const r = await runScheduler(h.io);
    expect(r.outcome).toBe("done");
    expect(h.order).toEqual(["T001@1", "T002@1", "T003@1"]);
    expect([...h.states.values()].every((s) => s.status === "completed")).toBe(true);
  });

  it("retries failed tasks up to maxTaskRetries with failure context", async () => {
    const h = harness(
      [task("T001")],
      (id, attempt) => (attempt === 1 ? outcome(id, "failed", "boom") : outcome(id, "completed")),
      { maxTaskRetries: 1 },
    );
    const r = await runScheduler(h.io);
    expect(r.outcome).toBe("done");
    expect(h.order).toEqual(["T001@1", "T001@2"]);
    expect(h.states.get("T001")?.status).toBe("completed");
  });

  it("marks tasks failed after exhausting retries and blocks dependents", async () => {
    const h = harness(
      [task("T001"), task("T002", ["T001"])],
      (id) => (id === "T001" ? outcome(id, "failed", "nope") : outcome(id, "completed")),
      { maxTaskRetries: 0 },
    );
    const r = await runScheduler(h.io);
    expect(r.outcome).toBe("done");
    expect(r.failedTasks).toEqual(["T001"]);
    expect(h.states.get("T001")?.status).toBe("failed");
    expect(h.states.get("T002")?.status).toBe("blocked");
  });

  it("handles blocked tasks", async () => {
    const h = harness([task("T001")], (id) => outcome(id, "blocked", "need secret"));
    const r = await runScheduler(h.io);
    expect(r.outcome).toBe("done");
    expect(h.states.get("T001")?.status).toBe("blocked");
  });

  it("needs_replan triggers replanning and continues", async () => {
    const h = harness(
      [task("T001")],
      (id, attempt) => (attempt === 1 ? "needs_replan_amend" : outcome(id, "completed")),
    );
    // Simulate the runtime resetting the task to pending after amendment.
    const original = h.io.onNeedsReplan;
    h.io.onNeedsReplan = async () => {
      const r = await original("T001");
      h.states.set("T001", { taskId: "T001", status: "pending", attempt: 1 });
      return r;
    };
    const result = await runScheduler(h.io);
    expect(result.outcome).toBe("done");
    expect(h.log).toContain("replan");
    expect(h.states.get("T001")?.status).toBe("completed");
  });

  it("running tasks from an interrupted run are retried", async () => {
    const h = harness([task("T001")], (id) => outcome(id, "completed"));
    h.states.set("T001", { taskId: "T001", status: "running", attempt: 1 });
    const r = await runScheduler(h.io);
    expect(r.outcome).toBe("done");
    expect(h.order).toEqual(["T001@2"]);
  });
});
