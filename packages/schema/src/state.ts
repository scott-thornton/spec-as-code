import { z } from "zod";

/**
 * Satisfaction states are qualitative. Percentages create false precision
 * and are prohibited for individual requirements.
 */

export const taskStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "blocked",
  "needs_replan",
  "skipped",
  "cancelled",
]);

export const requirementStatusSchema = z.enum([
  "unknown",
  "in_progress",
  "satisfied",
  "unsatisfied",
  "indeterminate",
  "waived",
]);

export const runStatusSchema = z.enum([
  "running",
  "succeeded",
  "partially_satisfied",
  "blocked",
  "failed",
  "cancelled",
]);

export const taskFailureSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
});

export const taskStateSchema = z.strictObject({
  taskId: z.string(),
  status: taskStatusSchema,
  attempt: z.number().int().nonnegative(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  failure: taskFailureSchema.optional(),
});

export const requirementStateSchema = z.strictObject({
  propertyId: z.string(),
  status: requirementStatusSchema,
  evidenceIds: z.array(z.string()),
  updatedAt: z.string(),
  reason: z.string().optional(),
  weakEvidence: z.boolean().optional(),
});

export const runStateSchema = z.strictObject({
  runId: z.string(),
  kind: z.enum(["apply", "verify"]),
  specId: z.string(),
  specDigest: z.string(),
  planId: z.string().optional(),
  planDigest: z.string().optional(),
  status: runStatusSchema,
  baseRevision: z.string().optional(),
  resultRevision: z.string().optional(),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  modelCalls: z.number().int().nonnegative(),
  replans: z.number().int().nonnegative(),
  tasks: z.record(z.string(), taskStateSchema),
  requirements: z.record(z.string(), requirementStateSchema),
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type RequirementStatus = z.infer<typeof requirementStatusSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type TaskFailure = z.infer<typeof taskFailureSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type RequirementState = z.infer<typeof requirementStateSchema>;
export type RunState = z.infer<typeof runStateSchema>;
