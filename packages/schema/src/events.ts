import { z } from "zod";

/**
 * The event log is append-only and is the source from which state is
 * reconstructed. state.json is a materialized projection, not truth.
 */

export const eventTypeSchema = z.enum([
  "RUN_CREATED",
  "SPEC_LOADED",
  "SPEC_VALIDATED",
  "REPOSITORY_OBSERVED",
  "PLAN_GENERATED",
  "PLAN_VALIDATED",
  "TASK_READY",
  "TASK_STARTED",
  "FILE_CHANGED",
  "COMMAND_EXECUTED",
  "OBSERVATION_RECORDED",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "TASK_BLOCKED",
  "TASK_NEEDS_REPLAN",
  "REPLAN_REQUESTED",
  "PLAN_AMENDED",
  "EVIDENCE_RECORDED",
  "PROPERTY_VERIFIED",
  "FOLLOWUP_CREATED",
  "FOLLOWUP_RESOLVED",
  "USAGE_RECORDED",
  "RUN_COMPLETED",
  "RUN_FAILED",
]);

export const eventSchema = z.strictObject({
  seq: z.number().int().positive(),
  id: z.string().min(1),
  type: eventTypeSchema,
  runId: z.string(),
  timestamp: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export type EventType = z.infer<typeof eventTypeSchema>;
export type Event = z.infer<typeof eventSchema>;

/** Well-known payload keys used by the state projection. */
export const EventPayloadKeys = {
  taskId: "taskId",
  attempt: "attempt",
  runId: "runId",
  specId: "specId",
  specDigest: "specDigest",
  planId: "planId",
  planDigest: "planDigest",
  status: "status",
  propertyId: "propertyId",
  evidenceIds: "evidenceIds",
  reason: "reason",
  weakEvidence: "weakEvidence",
  followupId: "followupId",
  observationId: "observationId",
  error: "error",
} as const;
