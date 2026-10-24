import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { digestOf } from "@spc/core";
import type {
  AcceptanceCriterion,
  Config,
  DesiredProperty,
  Evidence,
  EvidenceOutcome,
  FollowUpDraft,
} from "@spc/schema";
import type { LLMProvider, UsageRecord } from "@spc/llm";
import { makeUsageRecord } from "@spc/llm";
import { z } from "zod";
import { classifyCommand, evaluateCommandPolicy, runCommand, type CommandRunResult } from "@spc/executor";
import { classifyOracleValidity } from "./oracle-validity.js";
import { isSafeRelativePath } from "@spc/core";

/**
 * Deterministic criterion execution + agent/human paths. The verifier is
 * logically separate from the executor: independent context, separate
 * invocation, no planning conversation.
 */

export interface CriterionContext {
  runId: string;
  cwd: string;
  repositoryRevision: string;
  config: Config;
  provider: LLMProvider | null;
  taskId?: string;
  now?: () => string;
  onUsage?: (record: UsageRecord) => void;
  /** Commands already human-approved via resolved approval follow-ups (§52). */
  approvedCommands?: ReadonlySet<string>;
  /**
   * Per-sweep run cache: identical commands (same command, expected exit
   * code and timeout) execute at most once per verification sweep. The tree
   * does not change within a sweep, so a shared run is valid evidence for
   * every criterion that names it. Created by the sweep, not per criterion.
   */
  commandRuns?: Map<string, CommandRunResult>;
  /**
   * False only when the execution environment failed to prepare: the
   * criterion COULD NOT meaningfully execute. Command criteria then
   * report inconclusive without running - an invalid observation is
   * never a behavioral contradiction (run-mvix4mfx).
   */
  environmentReady?: boolean;
  /**
   * Agent-verdict cache, keyed by revision + property + criterion: a
   * judgment at a fixed revision is reusable across the sweeps of one
   * run (the field asked the same question ~6 times per run). Owned by
   * the RUN, not the sweep, when the caller provides one.
   */
  agentVerdicts?: Map<string, { outcome: "supports" | "contradicts" | "inconclusive"; justification: string }>;
  /** "red" marks the base-revision sweep of discriminating criteria. */
  phase?: "red";
  /**
   * Chain inheritance (criterion-level): criterionId -> prior runId whose
   * evidence records the red -> green flip, when the criterion merely
   * passes at this run's base. Digest-bound by construction (computed
   * from the parentRunId chain only).
   */
  inheritedFlips?: ReadonlyMap<string, string>;
}

export interface CriterionResult {
  evidence: Evidence;
  followUp?: FollowUpDraft & { criterionId: string };
  commandRun?: CommandRunResult;
}

/**
 * Child-runner infrastructure-death envelopes: output signatures that
 * mean the TEST RUNNER died, not that an assertion failed. Strict by
 * contract (failure-classification spec, 2026-10-24): fixture-backed
 * from the M0 board-flake captures, narrowed to runner envelopes the
 * code under test does not emit as ordinary error strings, and NEVER
 * applied to timed-out runs (a hang is potentially behavioral) nor to
 * signals alone. An infrastructure failure must never produce
 * supporting evidence, and must never be represented as a
 * demonstrated behavioral contradiction.
 */
export const INFRA_DEATH_SIGNATURES: RegExp[] = [
  /vitest[^\n]*worker[^\n]*exited unexpectedly/i,
  /vitest[^\n]*process[^\n]*(crashed|exited unexpectedly)/i,
  /worker process [^\n]* (terminated|exited unexpectedly)/i,
  /test runner crashed/i,
];

export function makeEvidence(
  base: Omit<Evidence, "digest">,
  now: () => string = () => new Date().toISOString(),
): Evidence {
  const record = { ...base, timestamp: base.timestamp ?? now() };
  const { digest: _omit, ...rest } = record as Evidence;
  return { ...record, digest: digestOf(rest) };
}

const agentVerdictSchema = z.strictObject({
  outcome: z.enum(["supports", "contradicts", "inconclusive"]),
  justification: z.string().min(1),
});

async function verifyCommand(
  criterion: AcceptanceCriterion & { type: "command" },
  property: DesiredProperty,
  ctx: CriterionContext,
): Promise<CriterionResult> {
  const timeoutMs = criterion.timeoutMs ?? ctx.config.execution.commandTimeoutMs;
  const decision = evaluateCommandPolicy(criterion.command, ctx.config.commands);
  const approved = ctx.approvedCommands?.has(criterion.command) ?? false;

  if (decision.policy === "approval" && !approved) {
    // §52: approval-class commands never run silently. Verification stays
    // inconclusive until a human approves via follow-up resolution.
    return {
      evidence: makeEvidence(
        {
          id: "pending",
          runId: ctx.runId,
          ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
          criterionId: criterion.id,
          propertyRefs: [property.id],
          kind: "command",
          outcome: "inconclusive",
          producer: { type: "runtime", identity: "awaiting-approval" },
          timestamp: (ctx.now ?? (() => new Date().toISOString()))(),
          repositoryRevision: ctx.repositoryRevision,
          payload: { command: criterion.command, reason: decision.reason },
        },
        ctx.now,
      ),
      followUp: {
        criterionId: criterion.id,
        type: "approval",
        blocking: false,
        title: `Approve command for ${property.id}: ${criterion.command}`,
        description: `The acceptance command is policy-gated ("${decision.category}"). Approving runs it during verification; rejecting keeps this property indeterminate.`,
        propertyId: property.id,
        command: criterion.command,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        options: [
          { id: "approve", description: "Allow this exact command during verification." },
          { id: "reject", description: "Keep the command blocked; the property stays indeterminate." },
        ],
        recommendedDefault: "approve",
      },
    };
  }

  if (ctx.environmentReady === false) {
    return {
      evidence: makeEvidence(
        {
          id: "pending",
          runId: ctx.runId,
          criterionId: criterion.id,
          propertyRefs: [property.id],
          kind: "command",
          outcome: "inconclusive",
          producer: { type: "runtime" },
          timestamp: (ctx.now ?? (() => new Date().toISOString()))(),
          repositoryRevision: ctx.repositoryRevision,
          payload: {
            command: criterion.command,
            reason: "environment preparation failed - the observation could not be made; not a behavioral contradiction",
          },
        },
        ctx.now,
      ),
    };
  }

  const category = classifyCommand(criterion.command);
  const expected = criterion.expect?.exitCode ?? 0;
  const runKey = `${criterion.command}\u0000${expected}\u0000${timeoutMs}`;
  const cached = ctx.commandRuns?.get(runKey);
  const run =
    cached ??
    (await runCommand(criterion.command, {
      cwd: ctx.cwd,
      timeoutMs,
      maxOutputBytes: ctx.config.execution.maxOutputBytes,
      commandsConfig: {
        ...ctx.config.commands,
        // Approved commands run once for verification regardless of the
        // approval policy category; deny-class policies still hold.
        ...(decision.policy === "approval" ? { [decision.category]: "allow" } : {}),
      } as Config["commands"],
    }));
  ctx.commandRuns?.set(runKey, run);
  const outcome: EvidenceOutcome = run.deniedReason
    ? "inconclusive"
    : run.exitCode === expected
      ? "supports"
      : "contradicts";
  // A contradicted run whose output shows the suite never collected
  // tests is not an assertion red: without this mark, a broken oracle
  // (bad import, syntax error) records identically to a genuine failing
  // assertion and the red->green flip certifies nothing (field
  // instance: EV-0001, "Tests: no tests" recorded as plain contradicts).
  const output = `${run.stdout}\n${run.stderr}`;
  const suiteNeverRan =
    outcome === "contradicts" &&
    (/tests?\s+no tests/i.test(output) ||
      /cannot find module/i.test(output) ||
      /failed suites/i.test(output) ||
      /failed to load/i.test(output) ||
      /must contain at least one test/i.test(output));
  // Runner infrastructure deaths are the one honest exception: the
  // machine died, not the assertion. Timeouts keep precedence and stay
  // contradicted (a hang is potentially behavioral); load failures
  // (suite-did-not-run) stay red-capable BY DESIGN - a suite that
  // cannot load because the implementation is absent at base IS the
  // red state module-import oracles depend on. Signals are context only.
  const infraDeath =
    outcome === "contradicts" &&
    !run.timedOut &&
    INFRA_DEATH_SIGNATURES.some((re) => re.test(output));
  const evidenceOutcome: EvidenceOutcome =
    outcome === "contradicts" && infraDeath ? "inconclusive" : outcome;
  const evidence = makeEvidence(
    {
      id: "pending",
      runId: ctx.runId,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      criterionId: criterion.id,
      propertyRefs: [property.id],
      kind: category === "test" ? "test" : "command",
      outcome: evidenceOutcome,
      producer: { type: "runtime" },
      timestamp: (ctx.now ?? (() => new Date().toISOString()))(),
      repositoryRevision: ctx.repositoryRevision,
      ...(ctx.phase ? { phase: ctx.phase } : {}),
      payload: {
        command: criterion.command,
        expectedExitCode: expected,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        stdout: run.stdout,
        stderr: run.stderr,
        ...(suiteNeverRan ? { failureShape: "suite-did-not-run" } : {}),
        ...(infraDeath ? { failureShape: "environment-death" } : {}),
        ...(run.signal ? { signal: run.signal } : {}),
        ...(
          outcome === "contradicts" && classifyOracleValidity(criterion.command, output).invalid
            ? { oracleValidity: "invalid" as const }
            : {}
        ),
        ...(run.deniedReason ? { deniedReason: run.deniedReason } : {}),
      },
    },
    ctx.now,
  );
  const result: CriterionResult = { evidence, commandRun: run };
  if (run.deniedReason) {
    result.followUp = {
      criterionId: criterion.id,
      type: "investigation",
      blocking: false,
      title: `Command policy blocked verification of ${property.id}`,
      description: `Acceptance command "${criterion.command}" was blocked: ${run.deniedReason}. Adjust command policy or the acceptance criterion.`,
      propertyId: property.id,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    };
  }
  return result;
}

function verifyFile(
  criterion: AcceptanceCriterion & { type: "file" },
  property: DesiredProperty,
  ctx: CriterionContext,
): CriterionResult {
  // File criteria are spec-authored, but the spec is executable
  // configuration: validate the path lexically before joining, the same
  // way the executor validates writes (external review #4).
  if (!isSafeRelativePath(criterion.path)) {
    return {
      evidence: makeEvidence(
        {
          id: "pending",
          runId: ctx.runId,
          ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
          criterionId: criterion.id,
          propertyRefs: [property.id],
          kind: "file",
          outcome: "inconclusive",
          producer: { type: "runtime", identity: "unsafe-criterion-path" },
          timestamp: (ctx.now ?? (() => new Date().toISOString()))(),
          repositoryRevision: ctx.repositoryRevision,
          payload: { path: criterion.path, reason: "criterion path is not a safe relative path" },
        },
        ctx.now,
      ),
      followUp: {
        criterionId: criterion.id,
        type: "investigation",
        blocking: false,
        title: `Unsafe file criterion path for ${property.id}`,
        description: `Criterion ${criterion.id} path "${criterion.path}" escapes the repository; fix the spec.`,
        propertyId: property.id,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      },
    };
  }
  const full = path.join(ctx.cwd, criterion.path);
  const exists = existsSync(full) && statSync(full).isFile();
  let content: string | null = null;
  if (exists) {
    try {
      content = readFileSync(full, "utf8");
    } catch {
      content = null;
    }
  }
  const a = criterion.assert;
  const checks: Record<string, boolean> = {};
  if (a.exists !== undefined) checks.exists = exists === a.exists;
  if (a.contains !== undefined) checks.contains = exists && content !== null && content.includes(a.contains);
  if (a.notContains !== undefined) {
    checks.notContains = !exists || content === null || !content.includes(a.notContains);
  }
  const allHold = Object.values(checks).every(Boolean);
  const evidence = makeEvidence(
    {
      id: "pending",
      runId: ctx.runId,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      criterionId: criterion.id,
      propertyRefs: [property.id],
      kind: "file",
      outcome: allHold ? "supports" : "contradicts",
      producer: { type: "runtime" },
      timestamp: (ctx.now ?? (() => new Date().toISOString()))(),
      repositoryRevision: ctx.repositoryRevision,
      ...(ctx.phase ? { phase: ctx.phase } : {}),
      payload: {
        path: criterion.path,
        assert: a,
        checks,
        observed: { exists, size: exists ? statSync(full).size : 0 },
      },
    },
    ctx.now,
  );
  return { evidence };
}

async function verifyAgent(
  criterion: AcceptanceCriterion & { type: "agent" },
  property: DesiredProperty,
  ctx: CriterionContext,
): Promise<CriterionResult> {
  const timestamp = (ctx.now ?? (() => new Date().toISOString()))();
  if (!ctx.provider) {
    return {
      evidence: makeEvidence(
        {
          id: "pending",
          runId: ctx.runId,
          ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
          criterionId: criterion.id,
          propertyRefs: [property.id],
          kind: "agent",
          outcome: "inconclusive",
          producer: { type: "runtime", identity: "no-provider" },
          timestamp,
          repositoryRevision: ctx.repositoryRevision,
          payload: { reason: "no LLM provider configured for agent verification" },
        },
        ctx.now,
      ),
      followUp: {
        criterionId: criterion.id,
        type: "investigation",
        blocking: false,
        title: `Agent verification unavailable for ${property.id}`,
        description: `Criterion ${criterion.id} requires an agent verifier but no provider is configured.`,
        propertyId: property.id,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      },
    };
  }
  const system =
    "You are an independent verifier. You receive a desired property, a verification instruction and repository context. " +
    "Judge only what the evidence supports: outcome supports / contradicts / inconclusive. Do not implement fixes. Respond with JSON only.";
  const prompt = JSON.stringify(
    {
      property: { id: property.id, statement: property.statement, priority: property.priority },
      instruction: criterion.instruction,
      note: "You are separate from the implementation; judge from the provided context and your own reading of the repository.",
    },
    null,
    2,
  );
  const cacheKey = `${ctx.repositoryRevision}\u0000${property.id}\u0000${criterion.id}`;
  const cached = ctx.agentVerdicts?.get(cacheKey);
  if (cached) {
    return {
      evidence: makeEvidence(
        {
          id: "pending",
          runId: ctx.runId,
          ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
          criterionId: criterion.id,
          propertyRefs: [property.id],
          kind: "agent",
          outcome: cached.outcome,
          producer: { type: "agent", identity: ctx.provider.name },
          timestamp,
          repositoryRevision: ctx.repositoryRevision,
          payload: {
            instruction: criterion.instruction,
            justification: cached.justification,
            cachedVerdict: true,
          },
        },
        ctx.now,
      ),
    };
  }
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const response = await ctx.provider.generateStructured({
    role: "verifier",
    key: `${property.id}:${criterion.id}`,
    requestId,
    system,
    prompt,
    schema: agentVerdictSchema,
    schemaName: "AgentVerdict",
  });
  ctx.onUsage?.(
    makeUsageRecord("verifier", requestId, { system, prompt }, JSON.stringify(response.value), {
      ...response.usage,
      durationMs: Date.now() - started,
    }, { taskId: ctx.taskId }),
  );
  ctx.agentVerdicts?.set(cacheKey, response.value);
  return {
    evidence: makeEvidence(
      {
        id: "pending",
        runId: ctx.runId,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        criterionId: criterion.id,
        propertyRefs: [property.id],
        kind: "agent",
        outcome: response.value.outcome,
        producer: { type: "agent", identity: ctx.provider.name },
        timestamp,
        repositoryRevision: ctx.repositoryRevision,
        payload: {
          instruction: criterion.instruction,
          justification: response.value.justification,
        },
      },
      ctx.now,
    ),
  };
}

function verifyHuman(
  criterion: AcceptanceCriterion & { type: "human" },
  property: DesiredProperty,
  ctx: CriterionContext,
): CriterionResult {
  const timestamp = (ctx.now ?? (() => new Date().toISOString()))();
  return {
    evidence: makeEvidence(
      {
        id: "pending",
        runId: ctx.runId,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        criterionId: criterion.id,
        propertyRefs: [property.id],
        kind: "human",
        outcome: "inconclusive",
        producer: { type: "runtime", identity: "awaiting-human" },
        timestamp,
        repositoryRevision: ctx.repositoryRevision,
        payload: { instruction: criterion.instruction, status: "outstanding" },
      },
      ctx.now,
    ),
    followUp: {
      criterionId: criterion.id,
      type: "manual_verification",
      blocking: false,
      title: `Manual review: ${property.id}`,
      description: criterion.instruction,
      propertyId: property.id,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      options: [
        { id: "confirm", description: "The property holds as far as human review can establish." },
        { id: "reject", description: "The property does not hold." },
      ],
      recommendedDefault: "confirm",
    },
  };
}

/** Dispatch one acceptance criterion. Independent of any executor context. */
export async function verifyCriterion(
  criterion: AcceptanceCriterion,
  property: DesiredProperty,
  ctx: CriterionContext,
): Promise<CriterionResult> {
  switch (criterion.type) {
    case "command":
      return verifyCommand(criterion, property, ctx);
    case "file":
      return verifyFile(criterion, property, ctx);
    case "agent":
      return verifyAgent(criterion, property, ctx);
    case "human":
      return verifyHuman(criterion, property, ctx);
  }
}
