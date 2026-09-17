import type { Plan, PlanAmendment, Task } from "@spc/schema";
import { error, type Diagnostic } from "../diagnostics.js";
import { findCycle } from "../graph.js";

export interface AmendmentApplyResult {
  plan: Plan | null;
  diagnostics: Diagnostic[];
}

/**
 * Apply a plan amendment deterministically. Tasks that already executed
 * (completed or running) can never be removed, replaced or re-targeted:
 * execution history is immutable.
 */
export function applyPlanAmendment(
  plan: Plan,
  amendment: PlanAmendment,
  executedTaskIds: readonly string[],
): AmendmentApplyResult {
  const diagnostics: Diagnostic[] = [];
  const executed = new Set(executedTaskIds);
  let tasks: Task[] = plan.tasks.map((t) => ({ ...t }));

  const find = (id: string): Task | undefined => tasks.find((t) => t.id === id);

  const assertNotExecuted = (id: string): boolean => {
    if (executed.has(id)) {
      diagnostics.push(
        error("SPC2013", `amendment touches task ${id}, which already executed; execution history is immutable.`),
      );
      return false;
    }
    return true;
  };

  for (const op of amendment.operations) {
    switch (op.op) {
      case "addTask": {
        if (find(op.task.id)) {
          diagnostics.push(error("SPC2014", `addTask: task ${op.task.id} already exists.`));
        } else {
          tasks.push({ ...op.task });
        }
        break;
      }
      case "removeTask": {
        if (!find(op.taskId)) {
          diagnostics.push(error("SPC2012", `removeTask: task ${op.taskId} not found.`));
          break;
        }
        if (!assertNotExecuted(op.taskId)) break;
        tasks = tasks.filter((t) => t.id !== op.taskId);
        // Dependents of a removed task lose that dependency edge.
        tasks = tasks.map((t) =>
          t.dependsOn?.includes(op.taskId)
            ? { ...t, dependsOn: t.dependsOn.filter((d) => d !== op.taskId) }
            : t,
        );
        break;
      }
      case "replaceTask": {
        const existing = find(op.taskId);
        if (!existing) {
          diagnostics.push(error("SPC2012", `replaceTask: task ${op.taskId} not found.`));
          break;
        }
        if (!assertNotExecuted(op.taskId)) break;
        if (op.task.id !== op.taskId && find(op.task.id)) {
          diagnostics.push(error("SPC2014", `replaceTask: task ${op.task.id} already exists.`));
          break;
        }
        tasks = tasks.map((t) => (t.id === op.taskId ? { ...op.task } : t));
        if (op.task.id !== op.taskId) {
          // Dependents of the old task now depend on the replacement.
          tasks = tasks.map((t) =>
            t.dependsOn?.includes(op.taskId)
              ? { ...t, dependsOn: [...new Set([...t.dependsOn.filter((d) => d !== op.taskId), op.task.id])] }
              : t,
          );
        }
        break;
      }
      case "addDependency": {
        if (!find(op.taskId) || !find(op.dependsOnTaskId)) {
          diagnostics.push(
            error("SPC2012", `addDependency: ${op.taskId} or ${op.dependsOnTaskId} not found.`),
          );
          break;
        }
        const edges = (id: string): string[] => {
          if (id === op.taskId) return [...new Set([...(find(id)?.dependsOn ?? []), op.dependsOnTaskId])];
          return find(id)?.dependsOn ?? [];
        };
        if (findCycle(tasks.map((t) => t.id), edges)) {
          diagnostics.push(
            error("SPC2015", `addDependency ${op.taskId} -> ${op.dependsOnTaskId} would create a cycle.`),
          );
          break;
        }
        tasks = tasks.map((t) =>
          t.id === op.taskId
            ? { ...t, dependsOn: [...new Set([...(t.dependsOn ?? []), op.dependsOnTaskId])] }
            : t,
        );
        break;
      }
      case "changeTarget": {
        const existing = find(op.taskId);
        if (!existing) {
          diagnostics.push(error("SPC2012", `changeTarget: task ${op.taskId} not found.`));
          break;
        }
        if (!assertNotExecuted(op.taskId)) break;
        tasks = tasks.map((t) => (t.id === op.taskId ? { ...t, targets: op.targets } : t));
        break;
      }
    }
  }

  if (diagnostics.length > 0) return { plan: null, diagnostics };

  const amended: Plan = { ...plan, tasks };
  const edges = (id: string): string[] => amended.tasks.find((t) => t.id === id)?.dependsOn ?? [];
  const cycle = findCycle(amended.tasks.map((t) => t.id), edges);
  if (cycle) {
    diagnostics.push(error("SPC2015", `amendment produces a dependency cycle: ${cycle.join(" -> ")}.`));
    return { plan: null, diagnostics };
  }
  return { plan: amended, diagnostics };
}
