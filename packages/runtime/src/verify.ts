import type { Config, DesiredProperty, Evidence, FollowUp, RequirementState, SpecIR } from "@spc/schema";
import type { LLMProvider, UsageRecord } from "@spc/llm";
import { evaluateProperty, verifyCriterion } from "@spc/verifier";
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
  now?: () => string;
  onUsage?: (record: UsageRecord) => void;
}

export interface VerifySweepResult {
  states: RequirementState[];
  evidence: Evidence[];
  followups: FollowUp[];
}

export async function verifyProperties(input: VerifySweepInput): Promise<VerifySweepResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const createdFollowups: FollowUp[] = [];

  for (const property of input.properties) {
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
      });
      if (result.commandRun && result.commandRun.allowed) {
        input.events.append("COMMAND_EXECUTED", {
          command: result.commandRun.command,
          cwd: result.commandRun.cwd,
          exitCode: result.commandRun.exitCode,
          durationMs: result.commandRun.durationMs,
          stdoutDigest: result.commandRun.stdoutDigest,
          stderrDigest: result.commandRun.stderrDigest,
          timedOut: result.commandRun.timedOut,
          ...(input.taskId ? { taskId: input.taskId } : {}),
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

  const states = input.properties.map((p) => {
    const state = evaluateProperty(p, input.evidence.all(), {
      allowAgentOnly: input.config.verification.allowAgentOnlyMustRequirements,
      now,
    });
    input.events.append("PROPERTY_VERIFIED", {
      propertyId: p.id,
      status: state.status,
      evidenceIds: state.evidenceIds,
      ...(state.reason ? { reason: state.reason } : {}),
      ...(state.weakEvidence ? { weakEvidence: true } : {}),
    });
    return state;
  });

  return { states, evidence: [...input.evidence.all()], followups: createdFollowups };
}

/** Standalone `spc verify`: a verify-only run against the current tree. */
export interface StandaloneVerifyInput {
  repoRoot: string;
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
}

export async function verifyStandalone(input: StandaloneVerifyInput): Promise<VerifySweepResult> {
  return verifyProperties({
    properties: input.specIr.properties,
    runId: input.runId,
    cwd: input.repoRoot,
    revision: input.revision,
    config: input.config,
    provider: input.provider,
    evidence: input.evidence,
    followups: input.followups,
    events: input.events,
    ...(input.now ? { now: input.now } : {}),
    ...(input.onUsage ? { onUsage: input.onUsage } : {}),
  });
}
