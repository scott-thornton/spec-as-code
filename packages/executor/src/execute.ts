import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globMatchAny, isPhysicallyContained, isSafeRelativePath, SpcError } from "@spc/core";
import type { AcceptanceCriterion, CommandsConfig, ObservationDraft, RepositorySnapshot, SpecIR, Task } from "@spc/schema";
import type { LLMProvider, UsageRecord } from "@spc/llm";
import { makeUsageRecord } from "@spc/llm";
import { readExcerpt, listMatchingFiles } from "@spc/repo";
import { enforceWriteScope, UNSAFE_PATH } from "./enforce.js";
import { buildExecutorPrompt, EXECUTOR_SYSTEM, type ExecutorTaskContext } from "./prompts.js";
import { executorResultSchema, type ExecutorResult } from "./result.js";
import { fileDigest, stageChanges } from "./patch.js";
import { runDeclaredCommands } from "./touchset.js";

export const EXECUTION_ERROR = "SPC_EXECUTION_ERROR";

export interface ExecuteTaskInput {
  task: Task;
  specIr: SpecIR;
  snapshot: RepositorySnapshot;
  worktreeRoot: string;
  attempt: number;
  priorResults: { taskId: string; summary: string }[];
  /** The run executing this task; stamped on the dispatched request so
   *  cancellation can retire the run's queue entries. */
  runId?: string;
  /** Staging rejections already recorded for this task attempt (derived
   *  from the run's event log by the runtime, live and on resume);
   *  offsets the requeue bound so restarts cannot reset it. */
  priorStageRejections?: number;
  observations: ObservationDraft[];
  failureContext?: { code: string; message: string };
  commands?: { commandsConfig: CommandsConfig; timeoutMs: number; maxOutputBytes: number };
  openClarifications?: { title: string; description: string; recommendedDefault?: string }[];
}

export interface ExecutionOutcome {
  taskId: string;
  status: "completed" | "failed" | "blocked" | "needs_replan";
  summary: string;
  result: ExecutorResult;
  appliedChanges: { path: string; change: string }[];
  executedCommands?: { command: string; exitCode: number | null }[];
  failure?: { code: string; message: string };
}

export interface ExecutorDeps {
  provider: LLMProvider;
  onUsage?: (record: UsageRecord) => void;
  /** Durable recording of a staging rejection - called BEFORE the next
   *  dispatch (event ordering is the restart-safety guarantee). */
  onStageRejection?: (code: string, message: string) => void;
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

/** Digest of the file's FULL content, read the same way the patch applicator
 * reads bases (utf8): the model copies this value into baseDigest, so it
 * references a digest of reality rather than a hash it computed itself. */
function digestOfWorktreeFile(worktreeRoot: string, relPath: string): string | undefined {
  try {
    return fileDigest(readFileSync(path.join(worktreeRoot, relPath), "utf8"));
  } catch {
    return undefined;
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
  // Write-target files get an honest excerpt budget: anchors must come
  // from shown text, and a 6KB window on a large edit target hides the
  // edit region and pushes executors toward whole-file resends - the
  // cumulative transport that corrupts bytes in transit. Read targets
  // keep the small window; they orient, they do not carry.
  const WRITE_EXCERPT_BYTES = 24 * 1024;
  const READ_EXCERPT_BYTES = 6 * 1024;
  const excerptWritePatterns = task.targets?.write ?? [];
  const readFiles = listMatchingFiles(worktreeRoot, readPatterns, 8).map((p) => {
    const digest = digestOfWorktreeFile(worktreeRoot, p);
    const budget = globMatchAny(excerptWritePatterns, p) ? WRITE_EXCERPT_BYTES : READ_EXCERPT_BYTES;
    return {
      path: p,
      content: readExcerpt(worktreeRoot, p, budget) ?? "",
      ...(digest ? { digest } : {}),
    };
  });

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

  // Bounded staging correction (specs/staging-requeue): an answer that
  // fails staging with an answer-defect code is re-dispatched carrying
  // the applicator's refusal as previousRejection - same task, same
  // attempt, new request id, the rejection durably recorded BEFORE the
  // next dispatch. Closed allowlist: scope and safety refusals are
  // plan-agreement failures and fail immediately. The bound is three
  // staging rounds per task attempt (offset by rounds already recorded,
  // so restarts cannot reset it) - at most four dispatches.
  const ELIGIBLE_STAGE_CODES = new Set([
    "PATCH_BASE_MISSING",
    "PATCH_BASE_MISMATCH",
    "PATCH_ANCHOR_ABSENT",
    "PATCH_ANCHOR_NOT_UNIQUE",
  ]);
  const STAGE_ROUND_BOUND = 3;
  let stageRejections = 0;

  let result: ExecutorResult;
  let stagedOk: Extract<ReturnType<typeof stageChanges>, { ok: true }> | undefined;
  let previousRejection: string | undefined;
  for (;;) {
    const requestId = crypto.randomUUID();
    const dispatchStarted = Date.now();
    try {
      const response = await deps.provider.generateStructured({
        role: "executor",
        key: `${task.id}@${attempt}`,
        requestId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(previousRejection ? { previousRejection } : {}),
        system: EXECUTOR_SYSTEM,
        prompt,
        schema: executorResultSchema,
        schemaName: "ExecutorResult",
      });
      deps.onUsage?.(
        makeUsageRecord("executor", requestId, { system: EXECUTOR_SYSTEM, prompt }, JSON.stringify(response.value), {
          ...response.usage,
          durationMs: Date.now() - dispatchStarted,
        }, { taskId: task.id }),
      );
      result = response.value;
    } catch (e) {
      const code = e instanceof SpcError ? e.code : "EXECUTOR_PROVIDER_ERROR";
      const message = (e as Error).message;
      deps.onUsage?.(
        makeUsageRecord("executor", requestId, { system: EXECUTOR_SYSTEM, prompt }, "", {
          model: "unknown",
          durationMs: Date.now() - dispatchStarted,
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
      if (!isSafeRelativePath(change.path) || !isPhysicallyContained(worktreeRoot, change.path)) {
        // Lexical safety plus PHYSICAL containment: a path whose components
        // traverse a symlink escapes the worktree where the git delta
        // cannot see it, so both checks reject.
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

    // Stage the entire change set before touching disk: any refusal (stale
    // base digest, absent or non-unique anchor) fails the whole set with
    // nothing written. No repair, no fallback to full-file rewrite.
    const staged = stageChanges(worktreeRoot, result.changes);
    if (staged.ok) {
      stagedOk = staged;
      break;
    }
    if (!ELIGIBLE_STAGE_CODES.has(staged.code)) {
      return {
        taskId: task.id,
        status: "failed",
        summary: `change set refused: ${staged.code}`,
        result,
        appliedChanges: [],
        failure: { code: staged.code, message: staged.message },
      };
    }
    // Durably record the round BEFORE re-dispatching: a crash between
    // the two must not lose it, and the event log is the restart-safety
    // source for the bound.
    deps.onStageRejection?.(staged.code, staged.message);
    stageRejections += 1;
    if ((input.priorStageRejections ?? 0) + stageRejections > STAGE_ROUND_BOUND) {
      return {
        taskId: task.id,
        status: "failed",
        summary: `change set refused: ${staged.code} (staging rounds exhausted)`,
        result,
        appliedChanges: [],
        failure: { code: staged.code, message: staged.message },
      };
    }
    previousRejection = staged.message;
  }

  const appliedChanges: { path: string; change: string }[] = [];
  for (const write of stagedOk!.writes) {
    const full = path.join(worktreeRoot, write.path);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, write.content, "utf8");
    appliedChanges.push({ path: write.path, change: write.label });
  }
  for (const p of stagedOk!.deletes) {
    rmSync(path.join(worktreeRoot, p), { force: true });
    appliedChanges.push({ path: p, change: "deleted" });
  }

  let executedCommands: { command: string; exitCode: number | null }[] | undefined;
  let summary = result.summary;
  // Executor results are untrusted input; a schema-bypassing producer may
  // omit defaulted fields, so treat a missing commands array as empty.
  const proposedCommands = result.commands ?? [];
  if (proposedCommands.length > 0) {
    if (!input.commands) {
      return {
        taskId: task.id,
        status: "failed",
        summary: "commands proposed but no command policy configured for this run",
        result,
        appliedChanges,
        failure: { code: "COMMAND_UNCONFIGURED", message: "result.commands is non-empty but ExecuteTaskInput.commands is absent; the runtime must always pass the configured command policy" },
      };
    }
    const commandOutcome = await runDeclaredCommands(worktreeRoot, proposedCommands, input.commands);
    if (!commandOutcome.ok) {
      return {
        taskId: task.id,
        status: "failed",
        summary: `command set refused: ${commandOutcome.code}`,
        result,
        appliedChanges,
        failure: { code: commandOutcome.code, message: commandOutcome.message },
      };
    }
    executedCommands = commandOutcome.results.map((r) => ({ command: r.command, exitCode: r.exitCode }));
    if (commandOutcome.untouched.length > 0) {
      summary = `${summary} (declared but unchanged: ${commandOutcome.untouched.join(", ")})`;
    }
  }

  return {
    taskId: task.id,
    status: result.status,
    summary,
    result,
    appliedChanges,
    ...(executedCommands ? { executedCommands } : {}),
    failure: result.failure
      ? { code: result.failure.code ?? "TASK_FAILED", message: result.failure.message }
      : undefined,
  };
}

/**
 * Derive the recorded staging-rejection count for a task attempt from
 * the run's event log - the restart-safety source for the requeue
 * bound; the runtime passes it as priorStageRejections (live and on
 * resume, uniformly, from the same event stream).
 */
export function stagingRoundsFrom(
  events: readonly { type: string; payload?: Record<string, unknown> }[],
  taskId: string,
  attempt: number,
): number {
  return events.filter(
    (e) => e.type === "TASK_STAGE_REJECTED" && e.payload?.taskId === taskId && e.payload?.attempt === attempt,
  ).length;
}
