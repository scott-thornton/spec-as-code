import { applyPlanAmendment, formatDiagnostics, hasErrors, validatePlan, type Diagnostic } from "@spc/core";
import type { Observation, Plan, PlanAmendment, SpecIR, TaskState } from "@spc/schema";
import type { LLMProvider, UsageRecord } from "@spc/llm";
import { makeUsageRecord } from "@spc/llm";
import { buildReplannerPrompt, REPLANNER_SYSTEM } from "./prompts.js";
import { replannerOutputSchema } from "./schemas.js";

export const MAX_AMENDMENT_REPAIR_ATTEMPTS = 2;

export interface GenerateAmendmentInput {
  specIr: SpecIR;
  plan: Plan;
  taskStates: Map<string, TaskState>;
  executedTaskIds: readonly string[];
  triggeringObservations: Observation[];
  provider: LLMProvider;
  amendmentId: string;
  now?: () => string;
  onUsage?: (record: UsageRecord) => void;
}

export interface GenerateAmendmentResult {
  amendment: PlanAmendment | null;
  amendedPlan: Plan | null;
  diagnostics: Diagnostic[];
  attempts: number;
}

/**
 * Generate a validated plan amendment from triggering observations.
 * Completed-task history is never erased (enforced by applyPlanAmendment
 * and re-validation).
 */
export async function generateAmendment(input: GenerateAmendmentInput): Promise<GenerateAmendmentResult> {
  const now = input.now ?? (() => new Date().toISOString());
  let repair: string | undefined;
  const totalAttempts = 1 + MAX_AMENDMENT_REPAIR_ATTEMPTS;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const prompt = buildReplannerPrompt({
      specIr: input.specIr,
      plan: input.plan,
      taskStates: input.taskStates,
      triggeringObservations: input.triggeringObservations,
      amendmentDiagnostics: repair,
    });
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const response = await input.provider.generateStructured({
      role: "replanner",
      key: input.triggeringObservations[0]?.taskId ?? input.triggeringObservations[0]?.id,
      requestId,
      system: REPLANNER_SYSTEM,
      prompt,
      schema: replannerOutputSchema,
      schemaName: "ReplannerOutput",
    });
    input.onUsage?.(
      makeUsageRecord("replanner", requestId, { system: REPLANNER_SYSTEM, prompt }, JSON.stringify(response.value), {
        ...response.usage,
        durationMs: Date.now() - started,
      }),
    );

    const amendment: PlanAmendment = {
      id: input.amendmentId,
      planId: input.plan.metadata.id,
      reason: response.value.reason,
      observationRefs: input.triggeringObservations.map((o) => o.id),
      operations: response.value.operations,
      createdAt: now(),
    };

    const applied = applyPlanAmendment(input.plan, amendment, input.executedTaskIds);
    if (applied.plan === null) {
      repair = formatDiagnostics(applied.diagnostics);
      if (attempt === totalAttempts) {
        return { amendment: null, amendedPlan: null, diagnostics: applied.diagnostics, attempts: attempt };
      }
      continue;
    }
    const diagnostics = validatePlan(applied.plan, input.specIr);
    if (hasErrors(diagnostics)) {
      repair = formatDiagnostics(diagnostics);
      if (attempt === totalAttempts) {
        return { amendment: null, amendedPlan: null, diagnostics, attempts: attempt };
      }
      continue;
    }
    return { amendment, amendedPlan: applied.plan, diagnostics, attempts: attempt };
  }
  throw new Error("amendment repair loop exited unexpectedly");
}
