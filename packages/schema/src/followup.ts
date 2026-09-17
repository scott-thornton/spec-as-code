import { z } from "zod";

/**
 * Follow-ups are first-class runtime data. Uncertainty must not return
 * to prose hidden in logs.
 */

export const followUpTypeSchema = z.enum([
  "human_input",
  "approval",
  "missing_secret",
  "missing_environment",
  "spec_clarification",
  "spec_change",
  "investigation",
  "replan",
  "manual_verification",
  "post_run",
]);

export const followUpOptionSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
});

const followUpCommon = {
  type: followUpTypeSchema,
  blocking: z.boolean(),
  title: z.string().min(1),
  description: z.string().min(1),
  propertyId: z.string().optional(),
  taskId: z.string().optional(),
  options: z.array(followUpOptionSchema).optional(),
  recommendedDefault: z.string().optional(),
  criterionId: z.string().optional(),
} as const;

export const followUpDraftSchema = z.strictObject({ ...followUpCommon });

export const followUpSchema = z.strictObject({
  ...followUpCommon,
  id: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(["open", "resolved"]),
  createdAt: z.string().min(1),
  resolvedAt: z.string().optional(),
  resolution: z
    .strictObject({
      optionId: z.string().optional(),
      note: z.string().optional(),
      resolvedBy: z.string().optional(),
    })
    .optional(),
});

export type FollowUpType = z.infer<typeof followUpTypeSchema>;
export type FollowUpOption = z.infer<typeof followUpOptionSchema>;
export type FollowUpDraft = z.infer<typeof followUpDraftSchema>;
export type FollowUp = z.infer<typeof followUpSchema>;
