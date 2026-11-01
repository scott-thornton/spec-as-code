import type { Config, DesiredProperty, Evidence, FollowUp, RequirementState, SpecIR } from "@spc/schema";
import type { LLMProvider, UsageRecord } from "@spc/llm";
import { CommandCache, type SharedCommandRun } from "@spc/verifier";
import { evaluateProperty, verifyCriterion, normalizeSuiteCriteria, type SuiteRegistry } from "@spc/verifier";
import type { EventStore } from "./events.js";
import type { EvidenceStore, FollowupStore } from "./stores.js";

/**
 * Verification sweep: execute acceptance criteria, persist evidence,
 * create human follow-ups (idempotently), derive property states.
 * Used by verify tasks, run completion and standalone `spc verify`.
 */
export interface VerifySweepInput {
  properties: DesiredProperty[];
  runId: string;
  cwd: string;
  revision: string;
  config: Config;
  provider: LLMProvider | null;
  evidence: EvidenceStore;
  followups: FollowupStore;
  events: EventStore;
  taskId?: string;
  /** "red" runs the sweep at the base revision, before any task executes. */
  phase?: "red";
  /**
   * Marks this sweep as part of an APPLY run (verify tasks, the final
   * sweep, the red sweep). Combined with verification.requireRedPhase,
   * such sweeps enforce the red -> green flip for discriminating
   * criteria: the flip is a property of introduction - observable and
   * enforced where the change lands. Standalone `spc verify` never sets
   * this and answers a present-tense question only, so satisfied specs
   * keep verifying green after the fact.
   */
  enforceRedPhase?: boolean;
  now?: () => string;
  onUsage?: (record: UsageRecord) => void;
  /** Invocation-owned command memo (specs/verify-dedup): when provided,
   *  repeated commands share ONE physical execution across sweeps and
   *  specs. Absent = fresh map per sweep (historical behavior). */
  commandRuns?: Map<string, SharedCommandRun>;
  /**
   * Frozen suite registry (specs/suite-references): loaded once per
   * invocation by the caller; the sweep normalizes suite criteria to
   * command form against it BEFORE any evaluation. A suite criterion
   * with no registry provided fails loud (SPC_SUITE_UNRESOLVED) - it
   * can never silently skip.
   */
  suites?: SuiteRegistry;
  /** Persisted command cache (specs/verify-cache): standalone
   *  verification only - threaded to verifyProperties -> criteria;
   *  apply sweeps never receive one. */
  commandCache?: CommandCache;
  /** Run-owned agent-verdict cache shared across sweeps (apply runs). */
  agentVerdicts?: Map<string, { outcome: "supports" | "contradicts" | "inconclusive"; justification: string }>;
  /** Criterion-level chain flips (criterionId -> prior runId), final sweep only. */
  inheritedFlips?: ReadonlyMap<string, string>;
  /** False only when the environment failed to prepare (see prepare.ts):
   *  command criteria report inconclusive without executing. */
  environmentReady?: boolean;
}

export interface VerifySweepResult {
  states: RequirementState[];
  evidence: Evidence[];
  followups: FollowUp[];
}

export async function verifyProperties(input: VerifySweepInput): Promise<VerifySweepResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const createdFollowups: FollowUp[] = [];

  // Suite resolution (specs/suite-references) happens BEFORE the memo
  // and cache ever see anything: two specs referencing one suite
  // normalize to the same command string and the existing
  // execution-identity machinery does the rest. No registry + suite
  // criteria = fail loud, never a silent skip.
  let properties = input.properties;
  let suiteProvenance: ReadonlyMap<string, { suite: string; suiteDigest: string }> | undefined;
  if (input.suites) {
    const normalized = normalizeSuiteCriteria(input.properties, input.suites);
    properties = normalized.properties;
    suiteProvenance = normalized.provenance.size > 0 ? normalized.provenance : undefined;
  } else if (input.properties.some((p) => p.acceptance.some((c) => c.type === "suite"))) {
    const e = new Error("suite-reference criteria present but no suite registry was provided to the sweep");
    (e as Error & { code?: string }).code = "SPC_SUITE_UNRESOLVED";
    throw e;
  }

  // §52: commands human-approved via resolved approval follow-ups may run.
  const approvedCommands = new Set<string>();
  for (const f of input.followups.all()) {
    if (f.status === "resolved" && f.type === "approval" && f.command && f.resolution?.optionId === "approve") {
      approvedCommands.add(f.command);
    }
  }

  // One run per distinct command per sweep: the tree is fixed within a
  // sweep, so repeated criteria share the execution instead of re-running
  // it. The memo belongs to the INVOCATION (specs/verify-dedup): a caller
  // may thread one across sweeps and specs - default is a fresh map,
  // exactly the historical per-sweep behavior.
  const commandRuns = input.commandRuns ?? new Map<string, SharedCommandRun>();

  for (const property of properties) {
    for (const criterion of property.acceptance) {
      // Human follow-ups are created once per criterion, not on every sweep.
      if (criterion.type === "human" && input.followups.findOpenForCriterion(criterion.id)) {
        continue;
      }
      const result = await verifyCriterion(criterion, property, {
        runId: input.runId,
        cwd: input.cwd,
        repositoryRevision: input.revision,
        config: input.config,
        provider: input.provider,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.onUsage ? { onUsage: input.onUsage } : {}),
        ...(approvedCommands.size > 0 ? { approvedCommands } : {}),
        ...(input.phase ? { phase: input.phase } : {}),
        commandRuns,
        ...(input.commandCache ? { commandCache: input.commandCache } : {}),
        ...(input.environmentReady === false ? { environmentReady: false } : {}),
        ...(input.agentVerdicts ? { agentVerdicts: input.agentVerdicts } : {}),
        ...(input.inheritedFlips ? { inheritedFlips: input.inheritedFlips } : {}),
        ...(suiteProvenance ? { suiteProvenance } : {}),
        now,
      });
      const evidence = input.evidence.add({
        ...result.evidence,
        id: `EV-${String(input.evidence.all().length + 1).padStart(4, "0")}`,
      });
      input.events.append("EVIDENCE_RECORDED", {
        evidenceId: evidence.id,
        propertyRefs: evidence.propertyRefs,
        ...(evidence.criterionId ? { criterionId: evidence.criterionId } : {}),
        kind: evidence.kind,
        outcome: evidence.outcome,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.phase ? { phase: input.phase } : {}),
      });
      // Audit precision (specs/verify-dedup): one COMMAND_EXECUTED per
      // real execution; a memo hit emits COMMAND_RESULT_REUSED naming
      // the execution identity - the criterion was independently
      // evaluated, the command physically ran once.
      if (result.execution?.reused) {
        input.events.append("COMMAND_RESULT_REUSED", {
          command: result.commandRun?.command ?? "",
          executionId: result.execution.executionId,
          originRunId: result.execution.originRunId,
          criterionId: criterion.id,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.phase ? { phase: input.phase } : {}),
        });
      } else if (result.commandRun && result.commandRun.allowed) {
        input.events.append("COMMAND_EXECUTED", {
          command: result.commandRun.command,
          cwd: result.commandRun.cwd,
          exitCode: result.commandRun.exitCode,
          durationMs: result.commandRun.durationMs,
          stdoutDigest: result.commandRun.stdoutDigest,
          stderrDigest: result.commandRun.stderrDigest,
          timedOut: result.commandRun.timedOut,
          ...(result.execution ? { executionId: result.execution.executionId } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.phase ? { phase: input.phase } : {}),
        });
      }
      if (result.followUp) {
        const { criterionId, ...draft } = result.followUp;
        const existing = input.followups.findOpenForCriterion(criterionId);
        if (!existing) {
          const created = input.followups.create({ ...draft, criterionId }, input.runId, now);
          input.events.append("FOLLOWUP_CREATED", {
            followupId: created.id,
            blocking: created.blocking,
            type: created.type,
            ...(created.propertyId ? { propertyId: created.propertyId } : {}),
          });
          createdFollowups.push(created);
        }
      }
    }
  }

  const states = properties.map((p) => {
    const state = evaluateProperty(p, input.evidence.all(), {
      allowAgentOnly: input.config.verification.allowAgentOnlyMustRequirements,
      ...(input.enforceRedPhase && input.config.verification.requireRedPhase ? { requireRedPhase: true } : {}),
      ...(input.inheritedFlips ? { inheritedFlips: input.inheritedFlips } : {}),
      now,
    });
    input.events.append("PROPERTY_VERIFIED", {
      propertyId: p.id,
      status: state.status,
      evidenceIds: state.evidenceIds,
      ...(state.reason ? { reason: state.reason } : {}),
      ...(state.weakEvidence ? { weakEvidence: true } : {}),
      ...(state.redPhase ? { redPhase: state.redPhase } : {}),
      ...(input.phase ? { phase: input.phase } : {}),
    });
    return state;
  });

  return { states, evidence: [...input.evidence.all()], followups: createdFollowups };
}

/** Standalone `spc verify`: a verify-only run against the current tree. */
export interface StandaloneVerifyInput {
  repoRoot: string;
  /** Where criteria execute. Defaults to repoRoot; revision verification
   * passes a temporary worktree at the run's result revision while
   * records still land under repoRoot. */
  executionRoot?: string;
  specIr: SpecIR;
  runId: string;
  config: Config;
  provider: LLMProvider | null;
  evidence: EvidenceStore;
  followups: FollowupStore;
  events: EventStore;
  revision: string;
  now?: () => string;
  onUsage?: (record: UsageRecord) => void;
  /** Outcome of preparing the execution environment (verify --run);
   *  recorded as structured evidence before criteria run. */
  prepareOutcome?: { mode: "installed" | "linked" | "none" | "failed"; exitCode?: number; detail?: string };
  /** Invocation-owned command memo (specs/verify-dedup): threaded to
   *  verifyProperties; absent = fresh per sweep. */
  commandRuns?: Map<string, SharedCommandRun>;
  /** Persisted command cache (specs/verify-cache): standalone verify
   *  paths thread one; apply sweeps pass none. */
  commandCache?: CommandCache;
  /** Frozen suite registry (specs/suite-references): threaded to
   *  verifyProperties for criterion normalization. */
  suites?: SuiteRegistry;
}

export async function verifyStandalone(input: StandaloneVerifyInput): Promise<VerifySweepResult> {
  if (input.prepareOutcome) {
    input.evidence.add({
      id: `EV-${String(input.evidence.all().length + 1).padStart(4, "0")}`,
      runId: input.runId,
      propertyRefs: [],
      kind: "preparation",
      outcome: input.prepareOutcome.mode === "failed" ? "inconclusive" : "supports",
      producer: { type: "runtime" },
      timestamp: input.now ? input.now() : new Date().toISOString(),
      repositoryRevision: input.revision,
      payload: {
        mode: input.prepareOutcome.mode,
        ...(input.prepareOutcome.exitCode !== undefined ? { exitCode: input.prepareOutcome.exitCode } : {}),
        ...(input.prepareOutcome.detail ? { detail: input.prepareOutcome.detail } : {}),
      },
    });
  }
  return verifyProperties({
    environmentReady: input.prepareOutcome ? input.prepareOutcome.mode !== "failed" : undefined,
    properties: input.specIr.properties,
    runId: input.runId,
    cwd: input.executionRoot ?? input.repoRoot,
    revision: input.revision,
    config: input.config,
    provider: input.provider,
    evidence: input.evidence,
    followups: input.followups,
    events: input.events,
    ...(input.now ? { now: input.now } : {}),
    ...(input.onUsage ? { onUsage: input.onUsage } : {}),
    ...(input.commandRuns ? { commandRuns: input.commandRuns } : {}),
    ...(input.commandCache ? { commandCache: input.commandCache } : {}),
    ...(input.suites ? { suites: input.suites } : {}),
  });
}
