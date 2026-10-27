import { z } from "zod";

export const policyValueSchema = z.enum(["allow", "approval", "deny"]);

export const providerConfigSchema = z.strictObject({
  name: z.enum(["fake", "openai", "anthropic", "harness", "none"]).default("none"),
  model: z.string().optional(),
  baseURL: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  script: z.string().optional(),
  /** Per-provider token limit. On the OpenAI wire this resolves with any
   *  request-level override into ONE field emitted under tokenLimitField;
   *  protocol expressibility is not model compatibility. */
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** Anthropic manual thinking budget (legacy mode): a TARGET inside the
   *  max_tokens ceiling - exhaustion stays detectable, never assumed away. */
  thinkingBudgetTokens: z.number().int().positive().optional(),
  /** Union of documented effort values across vendors; the adapter for the
   *  configured wire refuses values it cannot express at construction. */
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  /** OpenAI token-limit dialect: max_tokens (historical default) or
   *  max_completion_tokens (official API; reasoning tokens count inside
   *  the bound). */
  tokenLimitField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  /** Tri-state temperature: unset preserves the adapter's HISTORICAL
   *  default (Anthropic omits, OpenAI sends 0); false omits; true sends 0. */
  sendTemperature: z.boolean().optional(),
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
  /**
   * Amendment approval (§31): "auto" validates and continues every
   * amendment; "tiered" computes risk from the amendment's operations and
   * requires human approval (blocking follow-up) for high-risk ones.
   */
  amendmentApproval: z.enum(["auto", "tiered"]).default("auto"),
  /**
   * Commit the run branch after each task passes its write-scope check
   * (message: "spc: task <id> (run <runId>)"), recording the revision on
   * the task state. Default false: one result revision per run.
   */
  commitPerTask: z.boolean().default(false),
  /**
   * Execute in the repository checkout itself, on the run branch
   * (spc/<spec-id>/<run-id>), instead of an isolated git worktree. The
   * checkout switches to the run branch for the duration of the run and is
   * restored to the original branch afterwards; the run branch keeps the
   * result commits. Requires execution.parallelism 1 (parallel execution
   * writes through per-task worktrees).
   */
  inPlace: z.boolean().default(false),
  /**
   * Where in-place runs commit. "run" (default): the dedicated run branch,
   * original branch restored at run end. "current": whatever branch is
   * checked out - no branch switching at all, result commits land directly
   * on it (base revision still recorded, so diffs and reports work).
   * Detached HEAD is refused in "current" mode. Inert without
   * execution.inPlace.
   */
  inPlaceBranch: z.enum(["run", "current"]).default("run"),
  /** Harness provider: how long to wait for an external agent's answer per request. */
  harnessResponseTimeoutMs: z.number().int().positive().default(900_000),
  /**
   * Scoped dirt exemptions (strengthened contract): listed paths may be
   * dirty at preflight, but must remain unchanged, must never appear in
   * run commits, must not overlap task write scopes, and must not
   * contribute uncommitted state to verification evidence. Permission
   * to preserve dirt is never permission to incorporate it.
   */
  allowDirtyPaths: z.array(z.string().min(1)).optional(),
  /**
   * Role-specific response windows (planner/executor/replanner/
   * verifier). Roles without an entry use harnessResponseTimeoutMs.
   * Field case: verifier agent-review requests are the slow ones.
   */
  harnessTimeouts: z
    .record(z.enum(["planner", "executor", "replanner", "verifier"]), z.number().int().positive())
    .optional(),
  /** Extra high-risk write patterns for tiered amendment approval. */
  highRiskWritePatterns: z.array(z.string().min(1)).default([]),
  /**
   * Soft budgets, evaluated at run completion and reported - never
   * enforced. Exceeding one emits a BUDGET_SIGNAL event and a
   * non-blocking follow-up: "this run became unexpectedly large" is
   * state for the human, not a reason to fail. All fields optional.
   */
  budgets: z
    .strictObject({
      wallTimeMs: z.number().int().positive().optional(),
      diffLines: z.number().int().positive().optional(),
      changedFiles: z.number().int().positive().optional(),
    })
    .prefault({}),
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
  /**
   * Execute criteria marked `discriminating: true` once at the run's base
   * revision (before any task) and accept them only when they flip:
   * contradicted/inconclusive at base, supporting at result. A
   * discriminating criterion that already passes at base leaves the
   * property indeterminate - it tests nothing about the change. Flip
   * enforcement applies inside apply runs; standalone `spc verify` never
   * demands red evidence, so satisfied specs keep verifying green after
   * the fact.
   */
  requireRedPhase: z.boolean().default(false),
  /**
   * Glob patterns for verification assets (tests, oracles, gates) that no
   * task may change, regardless of its declared write targets. An agent
   * that can modify its own oracle can manufacture green; a task touching
   * a protected path fails with PROTECTED_PATH_WRITE. Changes to
   * protected paths happen deliberately, outside runs, as human edits.
   */
  protectedPaths: z.array(z.string().min(1)).default([]),
  /**
   * Anchor the run-completion attestation in Git: an empty commit on
   * the run branch carrying the event/evidence chain heads as
   * trailers, making post-run log tampering detectable against git
   * history itself. The attestation file and RUN_ATTESTED event are
   * always written; this gates only the git anchor. Skipped (with a
   * log line) in inPlaceBranch "current" mode to avoid surprise empty
   * commits on the user's own branch.
   */
  attestInGit: z.boolean().default(false),
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
