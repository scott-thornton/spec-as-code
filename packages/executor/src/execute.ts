import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSafeRelativePath, SpcError } from "@spc/core";
import type { AcceptanceCriterion, ObservationDraft, RepositorySnapshot, SpecIR, Task } from "@spc/schema";
import type { LLMProvider, UsageRecord } from "@spc/llm";
import { makeUsageRecord } from "@spc/llm";
import { readExcerpt, listMatchingFiles } from "@spc/repo";
import { enforceWriteScope, UNSAFE_PATH } from "./enforce.js";
import { buildExecutorPrompt, EXECUTOR_SYSTEM, type ExecutorTaskContext } from "./prompts.js";
import { executorResultSchema, type ExecutorResult } from "./result.js";

export const EXECUTION_ERROR = "SPC_EXECUTION_ERROR";

export interface ExecuteTaskInput {
  task: Task;
  specIr: SpecIR;
  snapshot: RepositorySnapshot;
  worktreeRoot: string;
  attempt: number;
  priorResults: { taskId: string; summary: string }[];
  observations: ObservationDraft[];
  failureContext?: { code: string; message: string };
  openClarifications?: { title: string; description: string; recommendedDefault?: string }[];
}

export interface ExecutionOutcome {
  taskId: string;
  status: "completed" | "failed" | "blocked" | "needs_replan";
  summary: string;
  result: ExecutorResult;
  appliedChanges: { path: string; change: string }[];
  failure?: { code: string; message: string };
}

export interface ExecutorDeps {
  provider: LLMProvider;
  onUsage?: (record: UsageRecord) => void;
}

function summarizeCriterion(c: AcceptanceCriterion): string {
  switch (c.type) {
    case "command":
      return `$ ${c.command ?? ""}`;
    case "file":
      return `file ${c.path ?? ""}`;
    case "agent":
    case "human":
      return c.instruction ?? "";
  }
}

/**
 * Execute one task through the provider, validate proposed changes against
 * the declared write scope, and apply them in the worktree. Actual git
 * deltas are re-checked by the runtime after this returns.
 */
export async function executeTask(input: ExecuteTaskInput, deps: ExecutorDeps): Promise<ExecutionOutcome> {
  const { task, specIr, snapshot, worktreeRoot, attempt } = input;
  const propertyIds = [...new Set([...(task.satisfies ?? []), ...(task.verifies ?? [])])];
  const properties = specIr.properties
    .filter((p) => propertyIds.includes(p.id))
    .map((p) => ({
      id: p.id,
      statement: p.statement,
      priority: p.priority,
      acceptance: p.acceptance.map((c) => ({
        id: c.id,
        type: c.type,
        summary: summarizeCriterion(c as never),
      })),
    }));

  const readPatterns = [...new Set([...(task.targets?.read ?? []), ...(task.targets?.write ?? [])])];
  const readFiles = listMatchingFiles(worktreeRoot, readPatterns, 8).map((p) => ({
    path: p,
    content: readExcerpt(worktreeRoot, p, 6144) ?? "",
  }));

  const ctx: ExecutorTaskContext = {
    task,
    properties,
    readFiles,
    priorResults: input.priorResults,
    observations: input.observations.map((o) => ({
      statement: o.statement,
      type: o.type,
      confidence: o.confidence,
    })),
    allowedReadPaths: readPatterns,
    allowedWritePaths: task.targets?.write ?? [],
    ...(input.failureContext
      ? { failureContext: { ...input.failureContext, attempt } }
      : {}),
    ...(input.openClarifications && input.openClarifications.length > 0
      ? {
          clarificationPolicy:
            "spec clarifications are non-blocking in this run: proceed with the recommendedDefault (or smallest defensible choice) and record the decision as an observation",
          openClarifications: input.openClarifications,
        }
      : {}),
  };

  const prompt = buildExecutorPrompt(ctx, specIr, snapshot);
  const requestId = crypto.randomUUID();
  const started = Date.now();

  let result: ExecutorResult;
  try {
    const response = await deps.provider.generateStructured({
      role: "executor",
      key: `${task.id}@${attempt}`,
      requestId,
      system: EXECUTOR_SYSTEM,
      prompt,
      schema: executorResultSchema,
      schemaName: "ExecutorResult",
    });
    deps.onUsage?.(
      makeUsageRecord("executor", requestId, { system: EXECUTOR_SYSTEM, prompt }, JSON.stringify(response.value), {
        ...response.usage,
        durationMs: Date.now() - started,
      }, { taskId: task.id }),
    );
    result = response.value;
  } catch (e) {
    const code = e instanceof SpcError ? e.code : "EXECUTOR_PROVIDER_ERROR";
    const message = (e as Error).message;
    deps.onUsage?.(
      makeUsageRecord("executor", requestId, { system: EXECUTOR_SYSTEM, prompt }, "", {
        model: "unknown",
        durationMs: Date.now() - started,
      }, { taskId: task.id, status: "error", errorCode: code }),
    );
    throw e;
  }

  // Pre-flight scope validation before touching the worktree.
  const writePatterns = task.targets?.write ?? [];
  const proposedPaths = result.changes.map((c) => c.path);
  const violations = enforceWriteScope(writePatterns, proposedPaths);
  if (violations.length > 0) {
    const v = violations[0]!;
    return {
      taskId: task.id,
      status: "failed",
      summary: `proposed changes violate the declared write scope`,
      result,
      appliedChanges: [],
      failure: { code: v.code, message: `${v.code}: ${v.reason}` },
    };
  }
  for (const change of result.changes) {
    if (!isSafeRelativePath(change.path)) {
      return {
        taskId: task.id,
        status: "failed",
        summary: "proposed an unsafe path",
        result,
        appliedChanges: [],
        failure: { code: UNSAFE_PATH, message: `${UNSAFE_PATH}: ${change.path}` },
      };
    }
  }

  const appliedChanges: { path: string; change: string }[] = [];
  for (const change of result.changes) {
    const full = path.join(worktreeRoot, change.path);
    if (change.op === "delete") {
      rmSync(full, { force: true });
      appliedChanges.push({ path: change.path, change: "deleted" });
    } else {
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, change.content, "utf8");
      appliedChanges.push({ path: change.path, change: change.op === "create" ? "created" : "modified" });
    }
  }

  return {
    taskId: task.id,
    status: result.status,
    summary: result.summary,
    result,
    appliedChanges,
    failure: result.failure
      ? { code: result.failure.code ?? "TASK_FAILED", message: result.failure.message }
      : undefined,
  };
}
