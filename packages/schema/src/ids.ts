import { z } from "zod";

/**
 * Stable identifier patterns shared across the system.
 *
 * Identity and presentation order are separate concepts: these patterns are
 * the only accepted forms for persisted identifiers.
 */

export const SPEC_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const PROPERTY_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
export const TASK_ID_PATTERN = /^T[0-9]{3,}$/;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const specIdSchema = z
  .string()
  .regex(SPEC_ID_PATTERN, "invalid spec id: must be lowercase kebab-case (e.g. oauth-login)");

export const propertyIdSchema = z
  .string()
  .regex(PROPERTY_ID_PATTERN, "invalid property id: must be UPPER-CASE with at least one dash (e.g. AUTH-001, AUTH-C01)");

export const taskIdSchema = z
  .string()
  .regex(TASK_ID_PATTERN, "invalid task id: must match T followed by at least three digits (e.g. T001)");

export const digestSchema = z
  .string()
  .regex(DIGEST_PATTERN, "invalid digest: must look like sha256:<64 lowercase hex chars>");
