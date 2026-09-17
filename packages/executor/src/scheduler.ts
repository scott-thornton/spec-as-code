import type { Plan, Task, TaskState } from "@spc/schema";
import type { ExecutionOutcome } from "./execute.js";

/**
 * Sequential DAG scheduler. The graph supports parallelism, but V0 executes
 * one ready task at a time in plan order. Only the runtime (via these
 * transitions) mutates lifecycle state.
 */

export interface SchedulerIO {
  getPlan(): Plan;
  getTaskState(taskId: string): TaskState | undefined;
  /** Persist a lifecycle transition (runtime records the matching event). */
  transition(taskId: string, state: TaskState): void;
  execute(task: Task, attempt: number, failureContext?: { code: string; message: string }): Promise<ExecutionOutcome>;
  /** Perform replanning; returns whether the plan was amended successfully. */
  onNeedsReplan(taskId: string): Promise<"amended" | "failed">;
  maxTaskRetries: number;
}

export interface SchedulerResult {
  outcome: "done" | "deadlocked" | "replan_failed";
  failedTasks: string[];
}

const BLOCKING_DEP_STATUSES = new Set(["failed", "blocked", "cancelled", "needs_replan"]);

export async function runScheduler(io: SchedulerIO): Promise<SchedulerResult> {
  const failedTasks: string[] = [];
  let replanFailed = false;

  for (;;) {
    const plan = io.getPlan();
    const tasks = plan.tasks;
    const stateOf = (id: string): TaskState =>
      io.getTaskState(id) ?? { taskId: id, status: "pending", attempt: 0 };
    const states = new Map(tasks.map((t) => [t.id, stateOf(t.id)]));

    // Interrupted run recovery: a task still marked running resumes as a retry.
    for (const t of tasks) {
      if (states.get(t.id)?.status === "running") {
        io.transition(t.id, { ...stateOf(t.id), status: "pending" });
        states.set(t.id, { ...stateOf(t.id), status: "pending" });
      }
    }

    // Pending tasks whose dependencies can never complete become blocked.
    for (const t of tasks) {
      if (states.get(t.id)?.status !== "pending") continue;
      const blockedDeps = (t.dependsOn ?? []).filter((d) => {
        const s = states.get(d)?.status;
        return s !== undefined && BLOCKING_DEP_STATUSES.has(s);
      });
      if (blockedDeps.length > 0) {
        const state: TaskState = { ...stateOf(t.id), status: "blocked" };
        io.transition(t.id, state);
        states.set(t.id, state);
      }
    }

    const pending = tasks.filter((t) => states.get(t.id)?.status === "pending");
    if (pending.length === 0) break;

    const ready = pending.filter((t) =>
      (t.dependsOn ?? []).every((d) => {
        const s = states.get(d)?.status;
        return s === "completed" || s === "skipped";
      }),
    );
    if (ready.length === 0) {
      return { outcome: "deadlocked", failedTasks };
    }

    const task = ready[0]!;
    const priorState = stateOf(task.id);
    const attempt = priorState.attempt + 1;
    io.transition(task.id, {
      taskId: task.id,
      status: "running",
      attempt,
      startedAt: new Date().toISOString(),
      ...(priorState.failure ? { failure: priorState.failure } : {}),
    });

    const failureContext =
      attempt > 1 && priorState.failure
        ? { code: priorState.failure.code, message: priorState.failure.message }
        : undefined;
    const outcome = await io.execute(task, attempt, failureContext);

    switch (outcome.status) {
      case "completed": {
        io.transition(task.id, {
          taskId: task.id,
          status: "completed",
          attempt,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });
        break;
      }
      case "failed": {
        const failure = outcome.failure ?? { code: "TASK_FAILED", message: outcome.summary };
        if (attempt - 1 < io.maxTaskRetries) {
          io.transition(task.id, { taskId: task.id, status: "pending", attempt, failure });
        } else {
          io.transition(task.id, {
            taskId: task.id,
            status: "failed",
            attempt,
            failure,
          });
          failedTasks.push(task.id);
        }
        break;
      }
      case "blocked": {
        io.transition(task.id, {
          taskId: task.id,
          status: "blocked",
          attempt,
          failure: outcome.failure ?? { code: "TASK_BLOCKED", message: outcome.summary },
        });
        break;
      }
      case "needs_replan": {
        io.transition(task.id, {
          taskId: task.id,
          status: "needs_replan",
          attempt,
          failure: outcome.failure,
        });
        const r = await io.onNeedsReplan(task.id);
        if (r === "amended") {
          // The runtime resets affected tasks to pending while applying the
          // amendment; the replaced task may no longer exist, so no direct
          // transition here - just continue the loop.
        } else {
          replanFailed = true;
        }
        break;
      }
    }

    if (replanFailed) return { outcome: "replan_failed", failedTasks };
  }

  return { outcome: "done", failedTasks };
}
