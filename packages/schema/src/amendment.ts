import { z } from "zod";
import { taskIdSchema } from "./ids.js";
import { taskSchema, taskTargetsSchema } from "./plan.js";

/**
 * Plan amendments are explicit, validated transitions — never silent
 * improvisation. Completed task history is preserved by the validator.
 */

export const amendmentOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("addTask"),
    task: taskSchema,
  }),
  z.strictObject({
    op: z.literal("removeTask"),
    taskId: taskIdSchema,
  }),
  z.strictObject({
    op: z.literal("replaceTask"),
    taskId: taskIdSchema,
    task: taskSchema,
  }),
  z.strictObject({
    op: z.literal("addDependency"),
    taskId: taskIdSchema,
    dependsOnTaskId: taskIdSchema,
  }),
  z.strictObject({
    op: z.literal("changeTarget"),
    taskId: taskIdSchema,
    targets: taskTargetsSchema,
  }),
]);

export const planAmendmentSchema = z.strictObject({
  id: z.string().min(1),
  planId: z.string().min(1),
  reason: z.string().min(1),
  observationRefs: z.array(z.string()),
  operations: z.array(amendmentOperationSchema),
  createdAt: z.string().min(1),
});

export type AmendmentOperation = z.infer<typeof amendmentOperationSchema>;
export type PlanAmendment = z.infer<typeof planAmendmentSchema>;
