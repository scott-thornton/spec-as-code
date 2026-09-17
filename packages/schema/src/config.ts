import { z } from "zod";

export const policyValueSchema = z.enum(["allow", "approval", "deny"]);

export const providerConfigSchema = z.strictObject({
  name: z.enum(["fake", "openai", "anthropic", "none"]).default("none"),
  model: z.string().optional(),
  baseURL: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  script: z.string().optional(),
});

export const executionConfigSchema = z.strictObject({
  requirePlanApproval: z.boolean().default(false),
  maxModelCalls: z.number().int().positive().default(50),
  maxReplans: z.number().int().positive().default(3),
  maxTaskRetries: z.number().int().nonnegative().default(1),
  commandTimeoutMs: z.number().int().positive().default(120_000),
  maxOutputBytes: z.number().int().positive().default(65_536),
  /** Max concurrently executing tasks (§78). 1 keeps sequential semantics. */
  parallelism: z.number().int().positive().default(1),
  /**
   * Demote blocking spec_clarification follow-ups to non-blocking and
   * proceed (§31 medium-risk tier; benchmark-driven iteration). The
   * follow-up is still recorded and visible after the run.
   */
  proceedOnClarificationFollowups: z.boolean().default(false),
});

export const commandsConfigSchema = z.strictObject({
  network: policyValueSchema.default("deny"),
  packageInstall: policyValueSchema.default("approval"),
  migration: policyValueSchema.default("approval"),
  deployment: policyValueSchema.default("deny"),
  publish: policyValueSchema.default("deny"),
  gitPush: policyValueSchema.default("deny"),
  destructive: policyValueSchema.default("deny"),
  unknown: policyValueSchema.default("allow"),
});

export const verificationConfigSchema = z.strictObject({
  allowAgentOnlyMustRequirements: z.boolean().default(false),
});

export const configSchema = z.strictObject({
  version: z.literal(1).default(1),
  provider: providerConfigSchema.prefault({ name: "none" }),
  execution: executionConfigSchema.prefault({}),
  commands: commandsConfigSchema.prefault({}),
  verification: verificationConfigSchema.prefault({}),
});

export type PolicyValue = z.infer<typeof policyValueSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;
export type CommandsConfig = z.infer<typeof commandsConfigSchema>;
export type VerificationConfig = z.infer<typeof verificationConfigSchema>;
export type Config = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: Config = configSchema.parse({});
