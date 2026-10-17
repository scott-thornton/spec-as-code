import { globMatchAny } from "@spc/core";
import type { Event, Plan } from "@spc/schema";

/**
 * Plan drift as a derived diagnostic - never a score. Answers "how much
 * did execution diverge from the original plan, and what shape did the
 * divergence take?" from events we already record. Justification is the
 * human's job; this only makes the divergence visible.
 */
export interface PlanDrift {
  originalTaskCount: number;
  tasksAdded: number;
  tasksRemoved: number;
  replans: number;
  filesChanged: number;
  filesOutsideOriginalTargets: string[];
}

export function computePlanDrift(events: readonly Event[], originalPlan: Plan): PlanDrift {
  let tasksAdded = 0;
  let tasksRemoved = 0;
  let replans = 0;
  const changed = new Set<string>();
  for (const e of events) {
    if (e.type === "REPLAN_REQUESTED") replans += 1;
    if (e.type === "PLAN_AMENDED") {
      const p = e.payload as { addedTaskIds?: string[]; removedTaskIds?: string[] };
      tasksAdded += Array.isArray(p.addedTaskIds) ? p.addedTaskIds.length : 0;
      tasksRemoved += Array.isArray(p.removedTaskIds) ? p.removedTaskIds.length : 0;
    }
    if (e.type === "FILE_CHANGED") {
      const p = e.payload as { path?: string };
      if (typeof p.path === "string") changed.add(p.path);
    }
  }
  const originalTargets = originalPlan.tasks.flatMap((t) => t.targets?.write ?? []);
  const filesOutsideOriginalTargets = [...changed].filter((f) => !globMatchAny(originalTargets, f));
  return {
    originalTaskCount: originalPlan.tasks.length,
    tasksAdded,
    tasksRemoved,
    replans,
    filesChanged: changed.size,
    filesOutsideOriginalTargets: filesOutsideOriginalTargets.sort(),
  };
}
