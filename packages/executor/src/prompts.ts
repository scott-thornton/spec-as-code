import type { Observation, RepositorySnapshot, SpecIR, Task } from "@spc/schema";

export const EXECUTOR_SYSTEM = `You are a bounded task executor in a spec-driven engineering system.

Contract:
- You execute exactly ONE task. Do not attempt other tasks or the whole plan.
- You may only change files that match the task's declared write targets.
- You never modify the specification, the plan, tests that verify other properties,
  or anything outside the declared scope.
- If you discover the plan is wrong (files do not exist, architecture differs,
  targets are incorrect), do NOT improvise: return status "needs_replan" with an
  observation describing the mismatch and which tasks it invalidates.
- If required information is missing (secrets, environment, spec ambiguity),
  return status "blocked" with a follow-up draft instead of guessing.
- EXCEPTION: if the context states clarification follow-ups are non-blocking
  in this run, a spec ambiguity is NOT a reason to block. Proceed using the
  open clarification's recommendedDefault (or the smallest defensible
  choice), and record the decision you made as an observation.
- Never claim that a requirement is satisfied. Verification happens elsewhere;
  "evidenceCandidates" are informational only.
- Every file you change must appear in "changes". Do not report changes you did not make.

Respond with a single JSON object matching the provided schema.`;

export interface ExecutorTaskContext {
  task: Task;
  clarificationPolicy?: string;
  openClarifications?: { title: string; description: string; recommendedDefault?: string }[];
  properties: { id: string; statement: string; priority: string; acceptance: { id: string; type: string; summary: string }[] }[];
  readFiles: { path: string; content: string }[];
  priorResults: { taskId: string; summary: string }[];
  observations: { statement: string; type: string; confidence: string }[];
  allowedReadPaths: string[];
  allowedWritePaths: string[];
  failureContext?: { code: string; message: string; attempt: number };
}

export function buildExecutorPrompt(
  ctx: ExecutorTaskContext,
  spec: SpecIR,
  snapshot: RepositorySnapshot,
): string {
  const payload = {
    spec: { id: spec.spec.metadata.id, title: spec.spec.metadata.title, goal: spec.spec.goal },
    repository: {
      revision: snapshot.revision,
      languages: snapshot.languages,
      commands: snapshot.commands,
    },
    task: ctx.task,
    relevantProperties: ctx.properties,
    allowedReadPaths: ctx.allowedReadPaths,
    allowedWritePaths: ctx.allowedWritePaths,
    dependencyResults: ctx.priorResults,
    observationsSoFar: ctx.observations,
    repositoryExcerpts: ctx.readFiles,
    previousFailure: ctx.failureContext,
    ...(ctx.clarificationPolicy ? { clarificationPolicy: ctx.clarificationPolicy } : {}),
    ...(ctx.openClarifications ? { openClarifications: ctx.openClarifications } : {}),
  };
  return [
    "Execute the following task. Respond with JSON only.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}
