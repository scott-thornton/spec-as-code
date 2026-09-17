import type { Plan, Task } from "@spc/schema";
import { digestOf } from "../hash.js";

function sortUnique(list: readonly string[]): string[] {
  return [...new Set(list)].sort();
}

function normalizeTask(t: Task): Task {
  return {
    ...t,
    ...(t.dependsOn ? { dependsOn: sortUnique(t.dependsOn) } : {}),
    ...(t.satisfies ? { satisfies: sortUnique(t.satisfies) } : {}),
    ...(t.verifies ? { verifies: sortUnique(t.verifies) } : {}),
    ...(t.targets
      ? {
          targets: {
            ...(t.targets.read ? { read: sortUnique(t.targets.read) } : {}),
            ...(t.targets.write ? { write: sortUnique(t.targets.write) } : {}),
          },
        }
      : {}),
  };
}

/**
 * Normalize documented set-like arrays (task dependsOn/satisfies/verifies,
 * targets). Task order and plan metadata are preserved.
 */
export function normalizePlan(plan: Plan): Plan {
  return { ...plan, tasks: plan.tasks.map(normalizeTask) };
}

export function planDigest(plan: Plan): string {
  return digestOf(normalizePlan(plan));
}
