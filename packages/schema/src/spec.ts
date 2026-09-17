import { z } from "zod";
import { propertyIdSchema, specIdSchema } from "./ids.js";

/**
 * Acceptance criteria: the verifiable form of a desired property.
 * Exactly four V0 types, ordered by evidence strength:
 * command (L1), file (L2), agent (L3), human (L4).
 */

export const commandExpectSchema = z.strictObject({
  exitCode: z.number().int().optional(),
});

export const fileAssertSchema = z
  .strictObject({
    exists: z.boolean().optional(),
    contains: z.string().optional(),
    notContains: z.string().optional(),
  })
  .refine((a) => a.exists !== undefined || a.contains !== undefined || a.notContains !== undefined, {
    message: "file assertion must specify at least one of exists, contains, notContains",
  });

export const acceptanceCriterionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: propertyIdSchema,
    type: z.literal("command"),
    command: z.string().min(1),
    expect: commandExpectSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.strictObject({
    id: propertyIdSchema,
    type: z.literal("file"),
    path: z.string().min(1),
    assert: fileAssertSchema,
  }),
  z.strictObject({
    id: propertyIdSchema,
    type: z.literal("agent"),
    instruction: z.string().min(1),
  }),
  z.strictObject({
    id: propertyIdSchema,
    type: z.literal("human"),
    instruction: z.string().min(1),
  }),
]);

export const prioritySchema = z.enum(["must", "should", "may"]);

/**
 * Higher-order requirement categories (§80). Metadata that shapes prompts,
 * rendering and category-aware lint warnings - never a separate verification
 * machinery (the four acceptance criterion types remain the only verifiers).
 */
export const requirementCategorySchema = z.enum([
  "behavioral",
  "security",
  "performance",
  "compatibility",
  "operational",
  "architectural",
  "ux",
  "compliance",
]);

export const artifactScopeSchema = z.strictObject({
  include: z.array(z.string().min(1)).optional(),
  exclude: z.array(z.string().min(1)).optional(),
});

const propertyCommon = {
  id: propertyIdSchema,
  statement: z.string().min(1),
  category: requirementCategorySchema.optional(),
  dependsOn: z.array(propertyIdSchema).optional(),
  acceptance: z.array(acceptanceCriterionSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
} as const;

export const requirementSchema = z.strictObject({
  ...propertyCommon,
  priority: prioritySchema,
  scope: artifactScopeSchema.optional(),
});

export const constraintSchema = z.strictObject({
  ...propertyCommon,
  priority: prioritySchema.optional(),
});

export const specSchema = z.strictObject({
  apiVersion: z.literal("spc.dev/v1alpha1"),
  kind: z.literal("Spec"),
  metadata: z.strictObject({
    id: specIdSchema,
    title: z.string().min(1),
    description: z.string().optional(),
  }),
  goal: z.string().min(1),
  /** Relative paths to other spec files whose properties compose into this one (§79). */
  imports: z.array(z.string().min(1)).optional(),
  /**
   * Named secret references (§53): presence-only declarations. Values are
   * never read into specs, plans, prompts or persisted records.
   */
  environment: z
    .strictObject({
      requiredSecrets: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  requirements: z.array(requirementSchema).min(1),
  constraints: z.array(constraintSchema).optional(),
  outOfScope: z.array(z.string()).optional(),
});

export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
export type CommandExpect = z.infer<typeof commandExpectSchema>;
export type FileAssert = z.infer<typeof fileAssertSchema>;
export type Priority = z.infer<typeof prioritySchema>;
export type RequirementCategory = z.infer<typeof requirementCategorySchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type Constraint = z.infer<typeof constraintSchema>;
export type Spec = z.infer<typeof specSchema>;

/**
 * Normalized forms produced by the compiler. Defaults are applied and
 * set-like arrays are sorted + de-duplicated. These are the shapes that get
 * hashed into digests.
 */

export type DesiredPropertyKind = "requirement" | "constraint";

export interface DesiredProperty {
  kind: DesiredPropertyKind;
  id: string;
  statement: string;
  priority: Priority;
  category?: RequirementCategory;
  dependsOn: string[];
  acceptance: AcceptanceCriterion[];
  scope?: { include?: string[]; exclude?: string[] };
  metadata?: Record<string, unknown>;
}

export interface NormalizedSpec extends Omit<Spec, "requirements" | "constraints" | "outOfScope"> {
  requirements: DesiredProperty[];
  constraints: DesiredProperty[];
  outOfScope: string[];
}

/** Categories whose must-properties deserve deterministic verification (SPC1009). */
export const HIGH_ASSURANCE_CATEGORIES: readonly RequirementCategory[] = ["security", "compliance"];

/** Compiled spec: immutable, digest-stamped, with a flat property index. */
export interface SpecIR {
  spec: NormalizedSpec;
  properties: DesiredProperty[];
  digest: string;
  /** Files composed into this spec via imports (transitive), for tooling. */
  importedFiles?: string[];
}

export function isDeterministicCriterion(c: AcceptanceCriterion): boolean {
  return c.type === "command" || c.type === "file";
}
