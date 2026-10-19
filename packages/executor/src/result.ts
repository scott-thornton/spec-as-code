import { z } from "zod";
import { followUpDraftSchema, observationDraftSchema } from "@spc/schema";

/**
 * The patch op carries the runtime-computed digest of the file content the
 * model was shown (repositoryExcerpts[].digest), an anchor that must occur
 * exactly once in that content, and its exact replacement. The applicator
 * refuses on any mismatch - it never repairs, normalizes, or falls back to
 * a full-file rewrite.
 */
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
    op: z.literal("patch"),
    path: z.string().min(1),
    baseDigest: z.string().min(1),
    anchor: z.string().min(1),
    replacement: z.string(),
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
  /**
   * Declared commands: the model states what a command will touch before
   * the runtime runs it; the observed content delta must fall inside the
   * declaration (declared == observed) or the writes revert and the task
   * fails. Commands that write anything must declare a touch-set.
   */
  commands: z
    .array(
      z.strictObject({
        command: z.string().min(1),
        touchSet: z.array(z.string().min(1)).optional(),
      }),
    )
    .default([]),
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
