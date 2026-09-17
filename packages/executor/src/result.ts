import { z } from "zod";
import { followUpDraftSchema, observationDraftSchema } from "@spc/schema";

export const proposedChangeSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("create"),
    path: z.string().min(1),
    content: z.string(),
  }),
  z.strictObject({
    op: z.literal("update"),
    path: z.string().min(1),
    content: z.string(),
  }),
  z.strictObject({
    op: z.literal("delete"),
    path: z.string().min(1),
  }),
]);

/**
 * Executor output protocol. The model proposes; the runtime applies policy.
 * The executor can never produce canonical spec/plan/lifecycle state.
 */
export const executorResultSchema = z.strictObject({
  status: z.enum(["completed", "failed", "blocked", "needs_replan"]),
  summary: z.string().min(1),
  changes: z.array(proposedChangeSchema).default([]),
  observations: z.array(observationDraftSchema).default([]),
  evidenceCandidates: z
    .array(
      z.strictObject({
        propertyId: z.string(),
        statement: z.string(),
      }),
    )
    .default([]),
  followups: z.array(followUpDraftSchema).default([]),
  failure: z
    .strictObject({
      code: z.string().optional(),
      message: z.string(),
    })
    .optional(),
  replanReason: z.string().optional(),
});

export type ProposedChange = z.infer<typeof proposedChangeSchema>;
export type ExecutorResult = z.infer<typeof executorResultSchema>;
