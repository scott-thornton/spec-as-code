import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Event, Plan, RequirementState, RunState, TaskState } from "@spc/schema";
import { runStateSchema } from "@spc/schema";

/**
 * state.json is a materialized projection over the event log. It can be
 * rebuilt at any time; it is never the sole source of truth.
 */

export interface RunMeta {
  runId: string;
  kind: "apply" | "verify";
  specId: string;
  specDigest: string;
  planId?: string;
  planDigest?: string;
  baseRevision?: string;
  branch?: string;
  worktree?: string;
  createdAt: string;
}

export function initialState(meta: RunMeta, plan: Plan | null): RunState {
  const tasks: Record<string, TaskState> = {};
  if (plan) {
    for (const t of plan.tasks) tasks[t.id] = { taskId: t.id, status: "pending", attempt: 0 };
  }
  return {
    runId: meta.runId,
    kind: meta.kind,
    specId: meta.specId,
    specDigest: meta.specDigest,
    ...(meta.planId ? { planId: meta.planId } : {}),
    ...(meta.planDigest ? { planDigest: meta.planDigest } : {}),
    status: "running",
    ...(meta.baseRevision ? { baseRevision: meta.baseRevision } : {}),
    ...(meta.branch ? { branch: meta.branch } : {}),
    ...(meta.worktree ? { worktree: meta.worktree } : {}),
    createdAt: meta.createdAt,
    updatedAt: meta.createdAt,
    modelCalls: 0,
    replans: 0,
    tasks,
    requirements: {},
  };
}

/** Fold one event into the state (pure copy-on-write). */
export function applyEvent(state: RunState, event: Event): RunState {
  const s: RunState = { ...state, tasks: { ...state.tasks }, requirements: { ...state.requirements } };
  const p = event.payload as Record<string, unknown>;
  const taskId = typeof p.taskId === "string" ? p.taskId : undefined;
  switch (event.type) {
    case "TASK_READY": {
      if (taskId) {
        const prior = s.tasks[taskId];
        s.tasks[taskId] = {
          taskId,
          status: "ready",
          attempt: typeof p.attempt === "number" ? p.attempt : prior?.attempt ?? 0,
          ...(prior?.failure ? { failure: prior.failure } : {}),
        };
      }
      break;
    }
    case "TASK_STARTED": {
      if (taskId) {
        const prior = s.tasks[taskId];
        s.tasks[taskId] = {
          taskId,
          status: "running",
          attempt: typeof p.attempt === "number" ? p.attempt : prior?.attempt ?? 0,
          startedAt: event.timestamp,
          ...(prior?.failure ? { failure: prior.failure } : {}),
        };
      }
      break;
    }
    case "TASK_COMPLETED": {
      if (taskId) {
        const prior = s.tasks[taskId];
        s.tasks[taskId] = {
          taskId,
          status: "completed",
          attempt: typeof p.attempt === "number" ? p.attempt : prior?.attempt ?? 0,
          ...(prior?.startedAt ? { startedAt: prior.startedAt } : {}),
          completedAt: event.timestamp,
        };
      }
      break;
    }
    case "TASK_FAILED": {
      if (taskId) {
        const prior = s.tasks[taskId];
        s.tasks[taskId] = {
          taskId,
          status: "failed",
          attempt: typeof p.attempt === "number" ? p.attempt : prior?.attempt ?? 0,
          ...(prior?.startedAt ? { startedAt: prior.startedAt } : {}),
          ...(p.error ? { failure: p.error as TaskState["failure"] } : prior?.failure ? { failure: prior.failure } : {}),
        };
      }
      break;
    }
    case "TASK_BLOCKED": {
      if (taskId) {
        const prior = s.tasks[taskId];
        s.tasks[taskId] = {
          taskId,
          status: "blocked",
          attempt: typeof p.attempt === "number" ? p.attempt : prior?.attempt ?? 0,
          ...(p.error ? { failure: p.error as TaskState["failure"] } : {}),
        };
      }
      break;
    }
    case "TASK_NEEDS_REPLAN": {
      if (taskId) {
        const prior = s.tasks[taskId];
        s.tasks[taskId] = { taskId, status: "needs_replan", attempt: prior?.attempt ?? 0 };
      }
      break;
    }
    case "REPLAN_REQUESTED": {
      s.replans += 1;
      break;
    }
    case "PLAN_AMENDED": {
      if (typeof p.planDigest === "string") s.planDigest = p.planDigest;
      const removed = Array.isArray(p.removedTaskIds) ? (p.removedTaskIds as string[]) : [];
      for (const id of removed) {
        const prior = s.tasks[id];
        if (!prior) {
          s.tasks[id] = { taskId: id, status: "skipped", attempt: 0 };
        } else if (prior.status !== "completed") {
          s.tasks[id] = { ...prior, status: "skipped" };
        }
      }
      const added = Array.isArray(p.addedTaskIds) ? (p.addedTaskIds as string[]) : [];
      for (const id of added) {
        s.tasks[id] = { taskId: id, status: "pending", attempt: 0 };
      }
      break;
    }
    case "PROPERTY_VERIFIED": {
      const propertyId = typeof p.propertyId === "string" ? p.propertyId : undefined;
      if (propertyId) {
        const rs: RequirementState = {
          propertyId,
          status: (p.status as RequirementState["status"]) ?? "unknown",
          evidenceIds: Array.isArray(p.evidenceIds) ? (p.evidenceIds as string[]) : [],
          updatedAt: event.timestamp,
          ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
          ...(p.weakEvidence === true ? { weakEvidence: true } : {}),
        };
        s.requirements[propertyId] = rs;
      }
      break;
    }
    case "USAGE_RECORDED": {
      s.modelCalls += 1;
      break;
    }
    case "RUN_COMPLETED":
    case "RUN_FAILED": {
      if (typeof p.status === "string") s.status = p.status as RunState["status"];
      if (typeof p.resultRevision === "string") s.resultRevision = p.resultRevision;
      break;
    }
    default:
      break;
  }
  s.updatedAt = event.timestamp;
  return s;
}

export function projectState(meta: RunMeta, plan: Plan | null, events: readonly Event[]): RunState {
  let state = initialState(meta, plan);
  for (const e of events) state = applyEvent(state, e);
  return state;
}

export function persistState(file: string, state: RunState): void {
  writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

export function loadState(file: string): RunState | null {
  if (!existsSync(file)) return null;
  const parsed = runStateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  return parsed.success ? parsed.data : null;
}
