import { z } from "zod";
import { amendmentOperationSchema, followUpDraftSchema, observationDraftSchema, taskSchema } from "@spc/schema";

/** Structured planner output. Never free text. */
export const plannerOutputSchema = z.strictObject({
  plan: z.strictObject({
    tasks: z.array(taskSchema).min(1),
  }),
  observations: z.array(observationDraftSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  followups: z.array(followUpDraftSchema).default([]),
});

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

/** Structured replanner output: an amendment proposal. */
export const replannerOutputSchema = z.strictObject({
  reason: z.string().min(1),
  operations: z.array(amendmentOperationSchema).min(1),
});

export type ReplannerOutput = z.infer<typeof replannerOutputSchema>;
