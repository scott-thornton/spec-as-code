import { formatDiagnostics, hasErrors, type Diagnostic } from "@spc/core";
import { normalizePlan, validatePlan } from "@spc/core";
import type { Plan, RepositorySnapshot, SpecIR } from "@spc/schema";
import type { LLMProvider, UsageRecord } from "@spc/llm";
import { makeUsageRecord } from "@spc/llm";
import { buildPlannerPrompt, PLANNER_SYSTEM } from "./prompts.js";
import { plannerOutputSchema } from "./schemas.js";

export const MAX_PLAN_REPAIR_ATTEMPTS = 2;

export interface GeneratePlanInput {
  specIr: SpecIR;
  snapshot: RepositorySnapshot;
  excerpts: { path: string; content: string }[];
  provider: LLMProvider;
  planId: string;
  now?: () => string;
  onUsage?: (record: UsageRecord) => void;
}

export interface GeneratePlanResult {
  plan: Plan | null;
  diagnostics: Diagnostic[];
  attempts: number;
}

/**
 * Generate a validated plan: structured output, deterministic validation,
 * bounded repair (max 2 additional attempts), fail visibly otherwise.
 */
export async function generatePlan(input: GeneratePlanInput): Promise<GeneratePlanResult> {
  const now = input.now ?? (() => new Date().toISOString());
  let repair: string | undefined;
  const totalAttempts = 1 + MAX_PLAN_REPAIR_ATTEMPTS;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const prompt = buildPlannerPrompt({ specIr: input.specIr, snapshot: input.snapshot, excerpts: input.excerpts }, repair);
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const response = await input.provider.generateStructured({
      role: "planner",
      key: `planner@${attempt}`,
      requestId,
      system: PLANNER_SYSTEM,
      prompt,
      schema: plannerOutputSchema,
      schemaName: "PlannerOutput",
    });
    input.onUsage?.(
      makeUsageRecord("planner", requestId, { system: PLANNER_SYSTEM, prompt }, JSON.stringify(response.value), {
        ...response.usage,
        durationMs: Date.now() - started,
      }),
    );

    const candidate: Plan = {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: {
        id: input.planId,
        createdAt: now(),
        generatedBy: { provider: input.provider.name, model: input.provider.model },
      },
      spec: { id: input.specIr.spec.metadata.id, digest: input.specIr.digest },
      repository: { revision: input.snapshot.revision, snapshotDigest: input.snapshot.digest },
      tasks: response.value.plan.tasks,
      assumptions: response.value.assumptions,
      followups: response.value.followups,
    };
    const normalized = normalizePlan(candidate);
    const diagnostics = validatePlan(normalized, input.specIr);
    if (!hasErrors(diagnostics)) {
      return { plan: normalized, diagnostics, attempts: attempt };
    }
    repair = formatDiagnostics(diagnostics);
    if (attempt === totalAttempts) {
      return { plan: null, diagnostics, attempts: attempt };
    }
  }
  // Unreachable: loop returns in every branch.
  throw new Error("planner repair loop exited unexpectedly");
}
