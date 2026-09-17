import { z } from "zod";
import { digestSchema, propertyIdSchema, specIdSchema, taskIdSchema } from "./ids.js";
import { followUpDraftSchema } from "./followup.js";

/**
 * Plans are transitions, not desired outcomes. Task runtime state never
 * lives here; state belongs to the runtime.
 */

export const taskKindSchema = z.enum(["inspect", "modify", "test", "verify", "cleanup"]);

export const taskTargetsSchema = z.strictObject({
  read: z.array(z.string().min(1)).optional(),
  write: z.array(z.string().min(1)).optional(),
});

export const taskSchema = z.strictObject({
  id: taskIdSchema,
  title: z.string().min(1),
  kind: taskKindSchema,
  intent: z.string().min(1),
  dependsOn: z.array(taskIdSchema).optional(),
  satisfies: z.array(propertyIdSchema).optional(),
  verifies: z.array(propertyIdSchema).optional(),
  targets: taskTargetsSchema.optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
});

export const planSchema = z.strictObject({
  apiVersion: z.literal("spc.dev/v1alpha1"),
  kind: z.literal("Plan"),
  metadata: z.strictObject({
    id: specIdSchema,
    title: z.string().optional(),
    createdAt: z.string().min(1),
    generatedBy: z
      .strictObject({
        provider: z.string().min(1),
        model: z.string().optional(),
      })
      .optional(),
  }),
  spec: z.strictObject({
    id: specIdSchema,
    digest: digestSchema,
  }),
  repository: z.strictObject({
    revision: z.string().min(1),
    snapshotDigest: digestSchema,
  }),
  tasks: z.array(taskSchema).min(1),
  assumptions: z.array(z.string()).optional(),
  followups: z.array(followUpDraftSchema).optional(),
});

export type Task = z.infer<typeof taskSchema>;
export type TaskKind = z.infer<typeof taskKindSchema>;
export type TaskTargets = z.infer<typeof taskTargetsSchema>;
export type Plan = z.infer<typeof planSchema>;
