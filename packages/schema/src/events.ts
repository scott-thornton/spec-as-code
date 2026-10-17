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
  "TASK_COMMITTED",
  "TASK_FAILED",
  "TASK_BLOCKED",
  "TASK_NEEDS_REPLAN",
  "REPLAN_REQUESTED",
  "PLAN_AMENDED",
  "PATCH_MERGED",
  "EXECUTION_CONFLICT",
  "EVIDENCE_RECORDED",
  "RED_PHASE_RECORDED",
  "PROPERTY_VERIFIED",
  "FOLLOWUP_CREATED",
  "FOLLOWUP_RESOLVED",
  "USAGE_RECORDED",
  "RUN_COMPLETED",
  "RUN_FAILED",
  "RUN_ATTESTED",
]);

export const eventSchema = z.strictObject({
  seq: z.number().int().positive(),
  id: z.string().min(1),
  type: eventTypeSchema,
  runId: z.string(),
  timestamp: z.string().min(1),
  /**
   * Chain pointer: the chain digest of the PREVIOUS event (the digest of
   * that event as stored, including its own chain field). Any edit,
   * deletion, insertion or reorder of an earlier event breaks the next
   * event's pointer. Absent on all events of legacy logs written before
   * chaining; a log that is partially chained is treated as corrupted.
   */
  chain: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

/** Genesis chain value for the first event of a chained log. */
export const EVENT_CHAIN_GENESIS = `sha256:${"0".repeat(64)}`;

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
