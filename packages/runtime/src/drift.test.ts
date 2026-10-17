import { describe, expect, it } from "vitest";
import type { Event, Plan } from "@spc/schema";
import { computePlanDrift } from "./drift.js";

const plan = {
  apiVersion: "spc.dev/v1alpha1",
  kind: "Plan",
  metadata: { id: "p", createdAt: "now" },
  spec: { id: "s", digest: "sha256:" + "0".repeat(64) },
  repository: { revision: "r", snapshotDigest: "sha256:" + "0".repeat(64) },
  tasks: [
    { id: "T001", title: "a", kind: "modify", intent: "i", dependsOn: [], satisfies: ["R-001"], targets: { write: ["src/a.ts"] } },
    { id: "T002", title: "b", kind: "modify", intent: "i", dependsOn: [], satisfies: ["R-001"], targets: { write: ["src/b/**"] } },
  ],
} as unknown as Plan;

function event(type: Event["type"], payload: Record<string, unknown>, seq: number): Event {
  return { seq, id: `e${seq}`, type, runId: "run-1", timestamp: "2026-01-01T00:00:00.000Z", payload };
}

describe("computePlanDrift", () => {
  it("as-planned execution reports zero divergence", () => {
    const drift = computePlanDrift(
      [event("FILE_CHANGED", { taskId: "T001", path: "src/a.ts", change: "created" }, 1)],
      plan,
    );
    expect(drift).toMatchObject({ originalTaskCount: 2, tasksAdded: 0, tasksRemoved: 0, replans: 0, filesChanged: 1 });
    expect(drift.filesOutsideOriginalTargets).toEqual([]);
  });

  it("amendments, replans and out-of-original-target files are visible", () => {
    const drift = computePlanDrift(
      [
        event("REPLAN_REQUESTED", {}, 1),
        event("FILE_CHANGED", { taskId: "T001", path: "src/a.ts", change: "created" }, 2),
        event("FILE_CHANGED", { taskId: "T002", path: "src/b/deep/x.ts", change: "created" }, 3),
        event("PLAN_AMENDED", { addedTaskIds: ["T003"], removedTaskIds: ["T002"] }, 4),
        event("FILE_CHANGED", { taskId: "T003", path: "src/unplanned.ts", change: "created" }, 5),
        event("FILE_CHANGED", { taskId: "T003", path: "src/more/y.ts", change: "created" }, 6),
      ],
      plan,
    );
    expect(drift.tasksAdded).toBe(1);
    expect(drift.tasksRemoved).toBe(1);
    expect(drift.replans).toBe(1);
    expect(drift.filesChanged).toBe(4);
    expect(drift.filesOutsideOriginalTargets).toEqual(["src/more/y.ts", "src/unplanned.ts"]);
  });
});
