import { z } from "zod";
import { digestSchema, propertyIdSchema, specIdSchema, taskIdSchema } from "./ids.js";
import { followUpDraftSchema } from "./followup.js";

/**
 * Plans are transitions, not desired outcomes. Task runtime state never
 * lives here; state belongs to the runtime.
 */

export const taskKindSchema = z.enum(["inspect", "modify", "test", "verify", "cleanup"]);

// Twin of @spc/core's isSafeRelativePath, inlined to keep the schema
// package at the bottom of the dependency graph: absolute paths and
// ..-escapes in task targets are authoring errors that used to die
// three layers later in plan validation, invisibly to the answerer.
const safeTargetPath = (p: string): boolean => {
  if (p === "") return false;
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;
  return p.split("/").every((s) => s.length > 0 && s !== "." && s !== "..");
};
const targetPaths = z
  .array(z.string().min(1))
  .refine((paths) => paths.every((p) => safeTargetPath(p)), {
    message: "task target paths must be safe relative paths (no absolute paths, no .. escapes)",
  });
export const taskTargetsSchema = z.strictObject({
  read: targetPaths.optional(),
  write: targetPaths.optional(),
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
