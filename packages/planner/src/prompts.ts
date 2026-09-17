import type { Observation, Plan, RepositorySnapshot, SpecIR, TaskState } from "@spc/schema";

export const PLANNER_SYSTEM = `You are a planning agent in a spec-driven engineering system.

Contract (invariants, enforced by the runtime after you respond):
- Do not implement code. Do not modify the specification. Do not invent requirements.
- Do not claim requirements are satisfied; produce a transition plan only.
- Every must-priority property must be addressed through task "satisfies" or "verifies".
- Every must-priority property needs a verification path: a verify task, or command/file
  acceptance criteria that the runtime can execute.
- When a property constrains EXISTING behaviour (e.g. "preserve the old API", "keep
  backwards compatibility"), plan verification that runs the repository's existing tests
  covering that behaviour - those tests already exist and must keep passing.
- If two tasks would write to the same file (or overlapping globs), order them explicitly
  with dependsOn or merge them into one task; never leave overlapping writers unordered.
- Task write targets must be explicit; inspect tasks must not declare write targets.
- Unknown repository facts should become inspection tasks, not assumptions.
- If specification information is missing or ambiguous (unnamed levels, undefined
  defaults, unspecified behaviour), emit a blocking follow-up draft
  (type spec_clarification) instead of inventing the missing decision.
- Prefer independently executable tasks; task ids must match T### (e.g. T001, T014).

Respond with a single JSON object matching the provided schema.`;

export const REPLANNER_SYSTEM = `You are a replanning agent. Execution discovered that part of the plan is wrong.

Contract:
- Produce a minimal plan amendment. Never rewrite history.
- You may: addTask, removeTask (only unexecuted), replaceTask (only unexecuted),
  addDependency, changeTarget (only unexecuted).
- Every must-priority property must remain covered and verifiable after the amendment.
- Address the triggering observations directly; do not expand scope beyond them.

Respond with a single JSON object matching the provided schema.`;

export interface PlannerContextInput {
  specIr: SpecIR;
  snapshot: RepositorySnapshot;
  excerpts: { path: string; content: string }[];
}

export function buildPlannerPrompt(input: PlannerContextInput, repair?: string): string {
  const payload = {
    spec: {
      id: input.specIr.spec.metadata.id,
      title: input.specIr.spec.metadata.title,
      goal: input.specIr.spec.goal,
      digest: input.specIr.digest,
      outOfScope: input.specIr.spec.outOfScope,
    },
    properties: input.specIr.properties.map((p) => ({
      kind: p.kind,
      id: p.id,
      statement: p.statement,
      priority: p.priority,
      dependsOn: p.dependsOn,
      acceptance: p.acceptance.map((c) => ({
        id: c.id,
        type: c.type,
        ...(c.type === "command" ? { command: c.command, expect: c.expect } : {}),
        ...(c.type === "file" ? { path: c.path, assert: c.assert } : {}),
        ...(c.type === "agent" || c.type === "human" ? { instruction: c.instruction } : {}),
      })),
    })),
    repository: {
      revision: input.snapshot.revision,
      dirty: input.snapshot.dirty,
      languages: input.snapshot.languages,
      manifests: input.snapshot.manifests,
      directories: input.snapshot.directories.slice(0, 60),
      tests: input.snapshot.tests.slice(0, 40),
      commands: input.snapshot.commands,
      relevantArtifacts: input.snapshot.relevantArtifacts,
    },
    repositoryExcerpts: input.excerpts,
  };
  const parts = ["Plan the transition for the following specification. Respond with JSON only.", "", JSON.stringify(payload, null, 2)];
  if (repair) {
    parts.push("", "Your previous plan failed deterministic validation. Diagnostics:", "", repair, "", "Produce a corrected plan.");
  }
  return parts.join("\n");
}

export interface ReplannerContextInput {
  specIr: SpecIR;
  plan: Plan;
  taskStates: Map<string, TaskState>;
  triggeringObservations: Observation[];
  amendmentDiagnostics?: string;
}

export function buildReplannerPrompt(input: ReplannerContextInput): string {
  const payload = {
    spec: { id: input.specIr.spec.metadata.id, goal: input.specIr.spec.goal },
    properties: input.specIr.properties.map((p) => ({ id: p.id, statement: p.statement, priority: p.priority })),
    currentPlan: {
      id: input.plan.metadata.id,
      tasks: input.plan.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        kind: t.kind,
        dependsOn: t.dependsOn ?? [],
        satisfies: t.satisfies ?? [],
        verifies: t.verifies ?? [],
        targets: t.targets ?? {},
        state: input.taskStates.get(t.id)?.status ?? "pending",
        executed: (input.taskStates.get(t.id)?.status ?? "pending") === "completed",
      })),
    },
    triggeringObservations: input.triggeringObservations.map((o) => ({
      id: o.id,
      type: o.type,
      statement: o.statement,
      confidence: o.confidence,
      invalidates: o.invalidates ?? {},
    })),
    amendmentRules: [
      "removeTask/replaceTask/changeTarget only allowed for tasks whose state is not completed",
      "the amended plan must still pass full validation",
    ],
  };
  const parts = ["Propose a plan amendment. Respond with JSON only.", "", JSON.stringify(payload, null, 2)];
  if (input.amendmentDiagnostics) {
    parts.push("", "Your previous amendment failed validation. Diagnostics:", "", input.amendmentDiagnostics);
  }
  return parts.join("\n");
}
