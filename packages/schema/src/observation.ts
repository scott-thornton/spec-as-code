import { z } from "zod";

/**
 * Observations capture facts discovered during execution that were not
 * known at planning time. They are the only sanctioned trigger for
 * replanning.
 */

export const observationTypeSchema = z.enum([
  "repository",
  "architecture",
  "dependency",
  "constraint",
  "environment",
  "unexpected",
]);

export const observationSchema = z.strictObject({
  id: z.string().min(1),
  runId: z.string(),
  taskId: z.string().optional(),
  type: observationTypeSchema,
  statement: z.string().min(1),
  confidence: z.enum(["confirmed", "inferred"]),
  evidenceIds: z.array(z.string()).optional(),
  invalidates: z
    .strictObject({
      taskIds: z.array(z.string()).optional(),
      plan: z.boolean().optional(),
    })
    .optional(),
});

/** Drafts are produced by planner/executor agents; the runtime assigns ids. */
export const observationDraftSchema = z.strictObject({
  type: observationTypeSchema,
  statement: z.string().min(1),
  confidence: z.enum(["confirmed", "inferred"]),
  evidenceIds: z.array(z.string()).optional(),
  invalidates: z
    .strictObject({
      taskIds: z.array(z.string()).optional(),
      plan: z.boolean().optional(),
    })
    .optional(),
});

export type Observation = z.infer<typeof observationSchema>;
export type ObservationDraft = z.infer<typeof observationDraftSchema>;
export type ObservationType = z.infer<typeof observationTypeSchema>;
