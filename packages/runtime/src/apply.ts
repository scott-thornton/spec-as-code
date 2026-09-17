import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compileSpecSource,
  formatDiagnostics,
  hasErrors,
  patternsOverlap,
  SpcError,
  validatePlan,
  planDigest as computePlanDigest,
} from "@spc/core";
import type { FollowUp, Observation, Plan, RequirementState, RunState, RunStatus, SpecIR, Task, TaskState } from "@spc/schema";
import type { LLMProvider, UsageRecord } from "@spc/llm";
import { executeTask, enforceWriteScope, runScheduler, type ExecutionOutcome } from "@spc/executor";
import { generateAmendment } from "@spc/planner";
import { commitAll, currentRevision, diffStat, git, statusDelta, statusPorcelain } from "@spc/repo";
import { createWorktree, removeWorktree } from "@spc/repo";
import { observeRepository } from "@spc/repo";
import { renderRunSummary } from "@spc/renderer";
import { mustPropertiesSatisfied } from "@spc/verifier";
import { EventStore } from "./events.js";
import { spcPaths, type SpcPaths } from "./paths.js";
import {
  isPlanApproved,
  latestPlanFile,
  listRunIds,
  loadConfig,
  loadPlanFile,
  loadRunMeta,
  newRunId,
  RUNTIME_ERROR,
  type RunMeta,
} from "./run.js";
import { initialState, persistState, projectState } from "./state.js";
import { appendUsageRecord, EvidenceStore, FollowupStore, ObservationStore } from "./stores.js";
import { verifyProperties } from "./verify.js";

export { RUNTIME_ERROR };

export interface ApplyDeps {
  providerFactory(): Promise<LLMProvider | null>;
  now?(): string;
  log?(line: string): void;
}

export interface ApplyOptions {
  repoRoot: string;
  planFile?: string;
  resumeRunId?: string;
  allowDirty?: boolean;
  force?: boolean;
}

export interface ApplyReport {
  status: RunStatus;
  runId: string;
  runDir: string;
  worktree?: string;
  branch?: string;
  baseRevision?: string;
  resultRevision?: string;
  requirements: RequirementState[];
  followups: FollowUp[];
  modelCalls: number;
  replans: number;
  diffStat?: string;
  changedFileCount?: number;
  summaryPath: string;
}

export interface RunContext {
  paths: SpcPaths;
  config: ReturnType<typeof loadConfig>;
  provider: LLMProvider | null;
  meta: RunMeta;
  specIr: SpecIR;
  plan: Plan;
  snapshotRevision: string;
  snapshotDigest: string;
  events: EventStore;
  evidence: EvidenceStore;
  observations: ObservationStore;
  followups: FollowupStore;
  state: RunState;
  worktreePath: string | null;
  worktreeBranch: string | null;
  modelCalls: number;
  now(): string;
  log(line: string): void;
}

function loadSpecIr(specsDir: string, specId: string): SpecIR {
  const specFile = findSpecFor(specsDir, specId);
  if (!specFile) {
    throw new SpcError(RUNTIME_ERROR, `no spec with id "${specId}" found under ${specsDir}`);
  }
  const result = compileSpecSource(readFileSync(specFile, "utf8"), specFile);
  if (!result.ok || !result.ir) {
    throw new SpcError(RUNTIME_ERROR, `spec ${specFile} is invalid:\n${formatDiagnostics(result.diagnostics)}`);
  }
  return result.ir;
}

function findSpecFor(specsDir: string, specId: string): string | null {
  if (!existsSync(specsDir)) return null;
  for (const entry of readdirSync(specsDir).sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const file = path.join(specsDir, entry);
    const result = compileSpecSource(readFileSync(file, "utf8"), file);
    if (result.ok && result.ir?.spec.metadata.id === specId) return file;
  }
  return null;
}

function checkPreflight(options: ApplyOptions, paths: SpcPaths, plan: Plan, specIr: SpecIR): void {
  const config = loadConfig(paths.configPath);
  const diagnostics = validatePlan(plan, specIr);
  if (hasErrors(diagnostics)) {
    throw new SpcError("PLAN_INVALID", `plan ${plan.metadata.id} failed validation:\n${formatDiagnostics(diagnostics)}`);
  }
  const status = statusPorcelain(paths.repoRoot);
  if (status.dirty && !options.allowDirty) {
    throw new SpcError(
      "DIRTY_REPOSITORY",
      `working tree is dirty (${status.entries.size} changed paths); commit or stash first, or pass --allow-dirty`,
    );
  }
  if (config.execution.requirePlanApproval && !isPlanApproved(paths, plan.metadata.id)) {
    throw new SpcError(
      "PLAN_APPROVAL_REQUIRED",
      `plan ${plan.metadata.id} requires approval before execution; run: spc plan approve ${plan.metadata.id}`,
    );
  }
  // Open blocking follow-ups from earlier runs of the same spec gate new runs.
  for (const runId of listRunIds(paths.runsDir)) {
    const followFile = path.join(paths.runsDir, runId, "followups.json");
    if (!existsSync(followFile)) continue;
    const list = JSON.parse(readFileSync(followFile, "utf8")) as FollowUp[];
    const blocking = list.filter((f) => f.status === "open" && f.blocking);
    if (blocking.length > 0) {
      const meta = loadRunMeta(paths.runsDir, runId);
      if (meta?.specId !== specIr.spec.metadata.id) continue;
      if (options.force) continue;
      throw new SpcError(
        "BLOCKED_BY_FOLLOWUP",
        `run ${runId} has unresolved blocking follow-ups:\n${blocking.map((f) => `  ${f.id} ${f.title}`).join("\n")}\nResolve with spc followup resolve, or pass --force`,
      );
    }
  }
}

/** Entry point for `spc apply`. */
export async function applyPlan(options: ApplyOptions, deps: ApplyDeps): Promise<ApplyReport> {
  const paths = spcPaths(options.repoRoot);
  const planFile = options.planFile ?? latestPlanFile(paths.plansDir);
  if (!planFile) {
    throw new SpcError(RUNTIME_ERROR, `no plans found under ${paths.plansDir}; run spc plan first`);
  }
  const plan = loadPlanFile(planFile);
  const specIr = loadSpecIr(paths.specsDir, plan.spec.id);
  checkPreflight(options, paths, plan, specIr);

  // Refuse to shadow an in-flight run of the same plan.
  for (const runId of listRunIds(paths.runsDir)) {
    const meta = loadRunMeta(paths.runsDir, runId);
    if (meta?.planId !== plan.metadata.id) continue;
    const stateFile = path.join(paths.runsDir, runId, "state.json");
    if (!existsSync(stateFile)) continue;
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { status: string };
    if (state.status === "running") {
      throw new SpcError(RUNTIME_ERROR, `run ${runId} is still marked running for this plan; resume with: spc apply --resume ${runId}`);
    }
  }

  const now = deps.now ?? (() => new Date().toISOString());
  const runId = newRunId();
  const runDir = paths.runDir(runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(path.join(runDir, "amendments"), { recursive: true });

  const snapshot = observeRepository(options.repoRoot, specIr, now);
  writeFileSync(paths.snapshotFile(runId), JSON.stringify(snapshot, null, 2), "utf8");

  const meta: RunMeta = {
    runId,
    kind: "apply",
    specId: specIr.spec.metadata.id,
    specDigest: specIr.digest,
    planId: plan.metadata.id,
    planDigest: computePlanDigest(plan),
    baseRevision: snapshot.revision,
    createdAt: now(),
  };
  writeFileSync(paths.metadataFile(runId), JSON.stringify(meta, null, 2), "utf8");

  const events = new EventStore(paths.eventsFile(runId), runId, now);
  events.append("RUN_CREATED", { runId, specId: meta.specId, specDigest: meta.specDigest, planId: meta.planId, baseRevision: meta.baseRevision });
  events.append("SPEC_LOADED", { specId: meta.specId, digest: meta.specDigest });
  events.append("SPEC_VALIDATED", { digest: meta.specDigest });
  events.append("REPOSITORY_OBSERVED", { snapshotDigest: snapshot.digest, revision: snapshot.revision });
  events.append("PLAN_VALIDATED", { planId: meta.planId, planDigest: meta.planDigest });

  const provider = await deps.providerFactory();
  const ctx: RunContext = {
    paths,
    config: loadConfig(paths.configPath),
    provider,
    meta,
    specIr,
    plan,
    snapshotRevision: snapshot.revision,
    snapshotDigest: snapshot.digest,
    events,
    evidence: new EvidenceStore(paths.evidenceFile(runId)),
    observations: new ObservationStore(paths.observationsFile(runId)),
    followups: new FollowupStore(paths.followupsFile(runId)),
    state: initialState(meta, plan),
    worktreePath: null,
    worktreeBranch: null,
    modelCalls: 0,
    now,
    log: deps.log ?? (() => {}),
  };

  // Materialize planner follow-up drafts as first-class run follow-ups.
  // Benchmark-driven iteration (§31 medium-risk tier): with
  // execution.proceedOnClarificationFollowups, spec_clarification drafts are
  // demoted to non-blocking — recorded and visible, but not run-gating.
  for (const draft of plan.followups ?? []) {
    const demote =
      ctx.config.execution.proceedOnClarificationFollowups &&
      draft.type === "spec_clarification" &&
      draft.blocking;
    const f = ctx.followups.create(demote ? { ...draft, blocking: false } : draft, runId, now);
    events.append("FOLLOWUP_CREATED", {
      followupId: f.id,
      blocking: f.blocking,
      type: f.type,
      ...(f.propertyId ? { propertyId: f.propertyId } : {}),
      ...(demote ? { demoted: true } : {}),
    });
    if (demote) {
      ctx.log(`Follow-up ${f.id} ("${f.title}") demoted to non-blocking by policy; proceeding.`);
    }
  }
  const blocking = ctx.followups.openBlocking();
  if (blocking.length > 0 && !options.force) {
    ctx.log(`Blocked by follow-ups: ${blocking.map((f) => f.id).join(", ")}`);
    return finalize(ctx, "blocked", []);
  }

  // Execution isolation: one worktree per run (plus per-task worktrees when
  // execution.parallelism > 1).
  const wt = createWorktree(options.repoRoot, meta.specId, runId, paths.worktreesDir);
  ctx.worktreePath = wt.path;
  ctx.worktreeBranch = wt.branch;
  ctx.meta = { ...meta, branch: wt.branch, worktree: wt.path };
  writeFileSync(paths.metadataFile(runId), JSON.stringify(ctx.meta, null, 2), "utf8");

  return ctx.config.execution.parallelism > 1 ? driveRunParallel(ctx) : driveRun(ctx);
}

/** Entry point for `spc apply --resume <runId>`. */
export async function resumeRun(options: ApplyOptions & { resumeRunId: string }, deps: ApplyDeps): Promise<ApplyReport> {
  const paths = spcPaths(options.repoRoot);
  const runId = options.resumeRunId;
  const runDir = paths.runDir(runId);
  if (!existsSync(runDir)) {
    throw new SpcError(RUNTIME_ERROR, `run ${runId} not found under ${paths.runsDir}`);
  }
  const meta = loadRunMeta(paths.runsDir, runId);
  if (!meta) throw new SpcError(RUNTIME_ERROR, `run ${runId} has no metadata.json`);
  const planFile = paths.planFile(meta.planId ?? "");
  if (!existsSync(planFile)) throw new SpcError(RUNTIME_ERROR, `plan file for run ${runId} is missing`);
  const plan = loadPlanFile(planFile);
  const specIr = loadSpecIr(paths.specsDir, plan.spec.id);
  const diagnostics = validatePlan(plan, specIr);
  if (hasErrors(diagnostics)) {
    throw new SpcError("PLAN_INVALID", `plan ${plan.metadata.id} failed validation:\n${formatDiagnostics(diagnostics)}`);
  }

  const now = deps.now ?? (() => new Date().toISOString());
  const events = new EventStore(paths.eventsFile(runId), runId, now);
  events.load();
  const state = projectState(meta, plan, events.all());
  if (state.status !== "running") {
    throw new SpcError(RUNTIME_ERROR, `run ${runId} already finished with status ${state.status}`);
  }
  if (!meta.worktree || !existsSync(meta.worktree)) {
    throw new SpcError(RUNTIME_ERROR, `worktree for run ${runId} is gone (${meta.worktree ?? "none"}); cannot resume safely`);
  }

  const snapshotFile = paths.snapshotFile(runId);
  const snapshot = existsSync(snapshotFile)
    ? (JSON.parse(readFileSync(snapshotFile, "utf8")) as { revision: string; digest: string })
    : { revision: meta.baseRevision ?? "unknown", digest: "unknown" };

  const provider = await deps.providerFactory();
  const evidence = new EvidenceStore(paths.evidenceFile(runId));
  evidence.load();
  const observations = new ObservationStore(paths.observationsFile(runId));
  observations.load();
  const followups = new FollowupStore(paths.followupsFile(runId));
  followups.load();

  const ctx: RunContext = {
    paths,
    config: loadConfig(paths.configPath),
    provider,
    meta,
    specIr,
    plan,
    snapshotRevision: snapshot.revision,
    snapshotDigest: snapshot.digest,
    events,
    evidence,
    observations,
    followups,
    state,
    worktreePath: meta.worktree ?? null,
    worktreeBranch: meta.branch ?? null,
    modelCalls: state.modelCalls,
    now,
    log: deps.log ?? (() => {}),
  };
  ctx.log(`Resuming run ${runId} (replayed ${events.length} events, ${Object.keys(state.tasks).length} tasks)`);
  return ctx.config.execution.parallelism > 1 ? driveRunParallel(ctx) : driveRun(ctx);
}

/** The scheduler loop plus verification, commit and completion semantics. */
async function driveRun(ctx: RunContext): Promise<ApplyReport> {
  const worktree = ctx.worktreePath!;
  const usageSink = (record: UsageRecord): void => {
    ctx.modelCalls += 1;
    appendUsageRecord(ctx.paths.usageFile(ctx.meta.runId), record);
    ctx.events.append("USAGE_RECORDED", { role: record.role, requestId: record.requestId, model: record.model });
  };

  let currentPlan = ctx.plan;
  let schedulerFailedTasks: string[] = [];
  let schedulerOutcome: "done" | "deadlocked" | "replan_failed" = "done";

  const transition = (taskId: string, next: TaskState): void => {
    ctx.state = { ...ctx.state, tasks: { ...ctx.state.tasks, [taskId]: next } };
    const p: Record<string, unknown> = { taskId, attempt: next.attempt };
    switch (next.status) {
      case "ready":
        ctx.events.append("TASK_READY", p);
        break;
      case "running":
        ctx.events.append("TASK_READY", p);
        ctx.events.append("TASK_STARTED", p);
        break;
      case "completed":
        ctx.events.append("TASK_COMPLETED", { ...p, summary: "task completed" });
        break;
      case "failed":
        ctx.events.append("TASK_FAILED", { ...p, error: next.failure ?? { code: "TASK_FAILED", message: "failed" } });
        break;
      case "blocked":
        ctx.events.append("TASK_BLOCKED", { ...p, error: next.failure ?? { code: "TASK_BLOCKED", message: "blocked" } });
        break;
      case "needs_replan":
        ctx.events.append("TASK_NEEDS_REPLAN", p);
        break;
      default:
        break;
    }
    persistState(ctx.paths.stateFile(ctx.meta.runId), ctx.state);
  };

  const onNeedsReplan = async (taskId: string): Promise<"amended" | "failed"> => {
    const triggering = ctx.observations.all().filter(
      (o) => o.taskId === taskId || (o.invalidates?.taskIds ?? []).includes(taskId),
    );
    ctx.events.append("REPLAN_REQUESTED", { taskId, observationIds: triggering.map((o) => o.id) });
    if (!ctx.provider) return failReplan("no provider configured for replanning");
    if (ctx.state.replans >= ctx.config.execution.maxReplans) {
      return failReplan(`replan budget exhausted (${ctx.config.execution.maxReplans})`);
    }
    const executed = Object.entries(ctx.state.tasks)
      .filter(([, s]) => s.status === "completed" || s.status === "running")
      .map(([id]) => id);
    const statesMap = new Map(Object.entries(ctx.state.tasks));
    const amendmentId = `AM-${String(ctx.state.replans + 1).padStart(3, "0")}`;
    const fallback: Observation[] =
      triggering.length > 0
        ? [...triggering]
        : [
            {
              id: "OBS-implicit",
              runId: ctx.meta.runId,
              taskId,
              type: "unexpected",
              statement: `task ${taskId} requested a replan`,
              confidence: "confirmed",
            },
          ];
    const result = await generateAmendment({
      specIr: ctx.specIr,
      plan: currentPlan,
      taskStates: statesMap,
      executedTaskIds: executed,
      triggeringObservations: fallback,
      provider: ctx.provider,
      amendmentId,
      now: ctx.now,
      onUsage: usageSink,
    });
    if (!result.amendment || !result.amendedPlan) {
      return failReplan(`amendment generation failed: ${formatDiagnostics(result.diagnostics)}`);
    }
    // Record the transition: previous plan versions are preserved in the run dir.
    const runDir = ctx.paths.runDir(ctx.meta.runId);
    const priorVersions = existsSync(runDir)
      ? readdirSync(runDir).filter((f) => /^plan-v\d+\.json$/.test(f)).length
      : 0;
    const versionFile = path.join(runDir, `plan-v${priorVersions + 1}.json`);
    writeFileSync(versionFile, JSON.stringify(currentPlan, null, 2), "utf8");
    writeFileSync(ctx.paths.planFile(currentPlan.metadata.id), JSON.stringify(result.amendedPlan, null, 2), "utf8");
    writeFileSync(path.join(ctx.paths.amendmentsDir(ctx.meta.runId), `${amendmentId}.json`), JSON.stringify(result.amendment, null, 2), "utf8");

    const oldIds = new Set(currentPlan.tasks.map((t) => t.id));
    const newIds = new Set(result.amendedPlan.tasks.map((t) => t.id));
    const removed = [...oldIds].filter((id) => !newIds.has(id));
    const added = [...newIds].filter((id) => !oldIds.has(id));
    for (const id of added) {
      ctx.state = { ...ctx.state, tasks: { ...ctx.state.tasks, [id]: { taskId: id, status: "pending", attempt: 0 } } };
    }
    currentPlan = result.amendedPlan;
    ctx.plan = result.amendedPlan;
    ctx.events.append("PLAN_AMENDED", {
      amendmentId,
      planDigest: computePlanDigest(result.amendedPlan),
      removedTaskIds: removed,
      addedTaskIds: added,
      operations: result.amendment.operations.map((o) => o.op),
    });
    ctx.state = { ...ctx.state, replans: ctx.state.replans + 1 };
    persistState(ctx.paths.stateFile(ctx.meta.runId), ctx.state);
    ctx.log(`Plan amended (${amendmentId}): +${added.length} / -${removed.length} tasks`);
    return "amended";
  };

  const failReplan = (reason: string): "failed" => {
    const f = ctx.followups.create(
      {
        type: "replan",
        blocking: true,
        title: `Replanning failed during task execution`,
        description: reason,
      },
      ctx.meta.runId,
      ctx.now,
    );
    ctx.events.append("FOLLOWUP_CREATED", { followupId: f.id, blocking: true, type: f.type });
    ctx.log(`Replanning failed: ${reason} (follow-up ${f.id})`);
    return "failed";
  };

  const execute = (task: Task, attempt: number, failureContext?: { code: string; message: string }): Promise<ExecutionOutcome> =>
    executeTaskInRun(ctx, usageSink, task, attempt, failureContext, worktree);

  const result = await runScheduler({
    getPlan: () => currentPlan,
    getTaskState: (id) => ctx.state.tasks[id],
    transition,
    execute,
    onNeedsReplan,
    maxTaskRetries: ctx.config.execution.maxTaskRetries,
  });
  schedulerFailedTasks = result.failedTasks;
  schedulerOutcome = result.outcome;
  return finishRun(ctx, currentPlan, usageSink, schedulerOutcome, schedulerFailedTasks);
}

/** Shared run tail: commit, final verification sweep, completion semantics. */
async function finishRun(
  ctx: RunContext,
  currentPlan: Plan,
  usageSink: (record: UsageRecord) => void,
  schedulerOutcome: "done" | "deadlocked" | "replan_failed",
  schedulerFailedTasks: readonly string[],
): Promise<ApplyReport> {
  const worktree = ctx.worktreePath!;
  ctx.state = { ...ctx.state, tasks: { ...ctx.state.tasks } };
  persistState(ctx.paths.stateFile(ctx.meta.runId), ctx.state);

  // Commit worktree changes (if any) so the branch holds the result revision.
  const baseRev = currentRevision(worktree);
  const resultRevision =
    commitAll(worktree, `spc: apply plan ${currentPlan.metadata.id} for ${ctx.meta.specId} (run ${ctx.meta.runId})`) ?? baseRev;
  const stat = diffStat(worktree, baseRev, resultRevision);
  const changedFileCount = countChanged(worktree, baseRev, resultRevision);

  // Final verification sweep over every property, in the worktree.
  const sweep = await verifyProperties({
    properties: ctx.specIr.properties,
    runId: ctx.meta.runId,
    cwd: worktree,
    revision: currentRevision(worktree),
    config: ctx.config,
    provider: ctx.provider,
    evidence: ctx.evidence,
    followups: ctx.followups,
    events: ctx.events,
    now: ctx.now,
    onUsage: usageSink,
  });
  ctx.state = {
    ...ctx.state,
    requirements: { ...ctx.state.requirements, ...Object.fromEntries(sweep.states.map((s) => [s.propertyId, s])) },
    resultRevision,
  };

  // Completion semantics: requirement satisfaction, not task completion.
  const statesMap = new Map(sweep.states.map((s) => [s.propertyId, s]));
  const blocking = ctx.followups.openBlocking();
  let status: RunStatus;
  if (blocking.length > 0) {
    status = "blocked";
  } else if (mustPropertiesSatisfied(ctx.specIr.properties, statesMap)) {
    status = "succeeded";
  } else if (schedulerOutcome === "replan_failed" || schedulerFailedTasks.length > 0) {
    status = "failed";
  } else {
    status = "partially_satisfied";
  }
  return finalize(ctx, status, sweep.states, {
    resultRevision,
    diffStat: stat || undefined,
    changedFileCount,
  });
}

/**
 * Execute one task inside a run (shared by the sequential and parallel
 * drivers): model budget guard, verify-task dispatch, executor invocation,
 * observation/evidence/follow-up persistence, and write-scope enforcement
 * against the actual git delta of `worktreeRoot`.
 */
export async function executeTaskInRun(
  ctx: RunContext,
  usageSink: (record: UsageRecord) => void,
  task: Task,
  attempt: number,
  failureContext: { code: string; message: string } | undefined,
  worktreeRoot: string,
): Promise<ExecutionOutcome> {
  if (ctx.modelCalls >= ctx.config.execution.maxModelCalls) {
    return {
      taskId: task.id,
      status: "failed",
      summary: "model call budget exhausted",
      result: { status: "failed", summary: "model call budget exhausted", changes: [], observations: [], evidenceCandidates: [], followups: [] },
      appliedChanges: [],
      failure: { code: "MODEL_BUDGET_EXCEEDED", message: `maxModelCalls=${ctx.config.execution.maxModelCalls}` },
    };
  }
  const before = statusPorcelain(worktreeRoot);

  if (task.kind === "verify") {
    const subset = ctx.specIr.properties.filter((p) => (task.verifies ?? []).includes(p.id));
    const sweep = await verifyProperties({
      properties: subset,
      runId: ctx.meta.runId,
      cwd: worktreeRoot,
      revision: currentRevision(worktreeRoot),
      config: ctx.config,
      provider: ctx.provider,
      evidence: ctx.evidence,
      followups: ctx.followups,
      events: ctx.events,
      taskId: task.id,
      now: ctx.now,
      onUsage: usageSink,
    });
    ctx.state = {
      ...ctx.state,
      requirements: { ...ctx.state.requirements, ...Object.fromEntries(sweep.states.map((s) => [s.propertyId, s])) },
    };
    const delta = statusDelta(before, statusPorcelain(worktreeRoot));
    const violations = enforceWriteScope(task.targets?.write ?? [], [...delta.keys()]);
    if (violations.length > 0) {
      return failedOutcome(task, violations[0]!.code, `${violations[0]!.code}: ${violations[0]!.reason}`);
    }
    const summary = sweep.states.map((s) => `${s.propertyId}=${s.status}`).join(", ");
    return {
      taskId: task.id,
      status: "completed",
      summary: `verification: ${summary}`,
      result: { status: "completed", summary: `verification: ${summary}`, changes: [], observations: [], evidenceCandidates: [], followups: [] },
      appliedChanges: [],
    };
  }

  if (!ctx.provider) {
    return failedOutcome(task, "NO_PROVIDER", "no LLM provider configured for execution");
  }
  const priorResults = Object.values(ctx.state.tasks)
    .filter((s) => s.status === "completed" && task.dependsOn?.includes(s.taskId))
    .map((s) => ({ taskId: s.taskId, summary: `completed (attempt ${s.attempt})` }));
  let outcome: ExecutionOutcome;
  try {
    outcome = await executeTask(
      {
        task,
        specIr: ctx.specIr,
        snapshot: {
          revision: ctx.snapshotRevision,
          dirty: false,
          languages: [],
          manifests: [],
          directories: [],
          tests: [],
          commands: {},
          relevantArtifacts: [],
          createdAt: ctx.now(),
          digest: ctx.snapshotDigest,
        },
        worktreeRoot,
        attempt,
        priorResults,
        observations: [...ctx.observations.all()],
        ...(failureContext ? { failureContext } : {}),
      },
      { provider: ctx.provider, onUsage: usageSink },
    );
  } catch (e) {
    return failedOutcome(task, (e as { code?: string }).code ?? "EXECUTOR_ERROR", (e as Error).message);
  }

  // Persist observations / evidence candidates / follow-up drafts.
  for (const draft of outcome.result.observations) {
    const obs = ctx.observations.add({ ...draft, taskId: task.id }, ctx.meta.runId);
    ctx.events.append("OBSERVATION_RECORDED", {
      observationId: obs.id,
      taskId: task.id,
      type: obs.type,
      statement: obs.statement,
      invalidates: obs.invalidates ?? {},
    });
  }
  for (const candidate of outcome.result.evidenceCandidates) {
    const evidence = ctx.evidence.add({
      id: `EV-${String(ctx.evidence.all().length + 1).padStart(4, "0")}`,
      runId: ctx.meta.runId,
      taskId: task.id,
      propertyRefs: [candidate.propertyId],
      kind: "agent",
      outcome: "supports",
      producer: { type: "agent", identity: ctx.provider.name },
      timestamp: ctx.now(),
      repositoryRevision: ctx.snapshotRevision,
      payload: { informationalClaim: candidate.statement },
    });
    ctx.events.append("EVIDENCE_RECORDED", { evidenceId: evidence.id, propertyRefs: evidence.propertyRefs, kind: "agent", outcome: "supports" });
  }
  for (const draft of outcome.result.followups) {
    const f = ctx.followups.create(draft, ctx.meta.runId, ctx.now);
    ctx.events.append("FOLLOWUP_CREATED", { followupId: f.id, blocking: f.blocking, type: f.type });
  }

  // Re-check the ACTUAL diff against the declared write scope.
  const delta = statusDelta(before, statusPorcelain(worktreeRoot));
  for (const [p, change] of delta) {
    ctx.events.append("FILE_CHANGED", { taskId: task.id, path: p, change });
  }
  const violations = enforceWriteScope(task.targets?.write ?? [], [...delta.keys()]);
  if (violations.length > 0 && outcome.status === "completed") {
    ctx.evidence.add({
      id: `EV-${String(ctx.evidence.all().length + 1).padStart(4, "0")}`,
      runId: ctx.meta.runId,
      taskId: task.id,
      propertyRefs: task.satisfies ?? [],
      kind: "diff",
      outcome: "contradicts",
      producer: { type: "runtime" },
      timestamp: ctx.now(),
      repositoryRevision: ctx.snapshotRevision,
      payload: { violations: violations.map((v) => ({ path: v.path, code: v.code, reason: v.reason })) },
    });
    return failedOutcome(task, violations[0]!.code, `${violations[0]!.code}: ${violations[0]!.reason}`);
  }
  if (delta.size > 0) {
    ctx.evidence.add({
      id: `EV-${String(ctx.evidence.all().length + 1).padStart(4, "0")}`,
      runId: ctx.meta.runId,
      taskId: task.id,
      propertyRefs: task.satisfies ?? [],
      kind: "diff",
      outcome: "supports",
      producer: { type: "runtime" },
      timestamp: ctx.now(),
      repositoryRevision: ctx.snapshotRevision,
      payload: { changedPaths: Object.fromEntries(delta) },
    });
  }
  return outcome;
}

function countChanged(worktree: string, from: string, to: string): number {
  const r = git(worktree, ["diff", "--name-only", `${from}..${to}`]);
  return r.stdout.split("\n").filter((l) => l.trim() !== "").length;
}

/**
 * Parallel driver (§78): ready tasks execute concurrently in per-task
 * worktrees branched from the integration HEAD, gated on disjoint write sets
 * (SPC2007 already orders overlapping writers with dependencies). Completed
 * task patches merge back into the integration branch deterministically; a
 * cherry-pick conflict becomes an EXECUTION_CONFLICT task failure, never a
 * silent resolution.
 */
async function driveRunParallel(ctx: RunContext): Promise<ApplyReport> {
  const integration = ctx.worktreePath!;
  const maxParallel = Math.max(1, ctx.config.execution.parallelism);
  const usageSink = (record: UsageRecord): void => {
    ctx.modelCalls += 1;
    appendUsageRecord(ctx.paths.usageFile(ctx.meta.runId), record);
    ctx.events.append("USAGE_RECORDED", { role: record.role, requestId: record.requestId, model: record.model });
  };
  const transition = (taskId: string, next: TaskState): void => {
    ctx.state = { ...ctx.state, tasks: { ...ctx.state.tasks, [taskId]: next } };
    const p: Record<string, unknown> = { taskId, attempt: next.attempt };
    if (next.status === "running") {
      ctx.events.append("TASK_READY", p);
      ctx.events.append("TASK_STARTED", p);
    } else if (next.status === "completed") {
      ctx.events.append("TASK_COMPLETED", { ...p, summary: "task completed" });
    } else if (next.status === "failed") {
      ctx.events.append("TASK_FAILED", { ...p, error: next.failure ?? { code: "TASK_FAILED", message: "failed" } });
    } else if (next.status === "blocked") {
      ctx.events.append("TASK_BLOCKED", { ...p, error: next.failure ?? { code: "TASK_BLOCKED", message: "blocked" } });
    } else if (next.status === "needs_replan") {
      ctx.events.append("TASK_NEEDS_REPLAN", p);
    }
    persistState(ctx.paths.stateFile(ctx.meta.runId), ctx.state);
  };

  let currentPlan = ctx.plan;
  let schedulerOutcome: "done" | "deadlocked" | "replan_failed" = "done";
  const failedTasks: string[] = [];
  const inFlight = new Map<string, Promise<void>>();
  const inFlightWrites = new Map<string, string[]>();
  const BLOCKING = new Set(["failed", "blocked", "cancelled", "needs_replan"]);

  const replanFor = async (taskId: string): Promise<"amended" | "failed"> => {
    // Drain in-flight siblings before touching the plan.
    while (inFlight.size > 0) await Promise.race([...inFlight.values()]);
    const triggering = ctx.observations.all().filter(
      (o) => o.taskId === taskId || (o.invalidates?.taskIds ?? []).includes(taskId),
    );
    ctx.events.append("REPLAN_REQUESTED", { taskId, observationIds: triggering.map((o) => o.id) });
    if (!ctx.provider) return "failed";
    if (ctx.state.replans >= ctx.config.execution.maxReplans) return "failed";
    const executed = Object.entries(ctx.state.tasks)
      .filter(([, s]) => s.status === "completed" || s.status === "running")
      .map(([id]) => id);
    const result = await generateAmendment({
      specIr: ctx.specIr,
      plan: currentPlan,
      taskStates: new Map(Object.entries(ctx.state.tasks)),
      executedTaskIds: executed,
      triggeringObservations:
        triggering.length > 0
          ? [...triggering]
          : [
              {
                id: "OBS-implicit",
                runId: ctx.meta.runId,
                taskId,
                type: "unexpected",
                statement: `task ${taskId} requested a replan`,
                confidence: "confirmed",
              },
            ],
      provider: ctx.provider,
      amendmentId: `AM-${String(ctx.state.replans + 1).padStart(3, "0")}`,
      now: ctx.now,
      onUsage: usageSink,
    });
    if (!result.amendment || !result.amendedPlan) return "failed";
    const amended = result.amendedPlan;
    const runDir = ctx.paths.runDir(ctx.meta.runId);
    const priorVersions = existsSync(runDir)
      ? readdirSync(runDir).filter((f) => /^plan-v\d+\.json$/.test(f)).length
      : 0;
    writeFileSync(path.join(runDir, `plan-v${priorVersions + 1}.json`), JSON.stringify(currentPlan, null, 2), "utf8");
    writeFileSync(ctx.paths.planFile(currentPlan.metadata.id), JSON.stringify(result.amendedPlan, null, 2), "utf8");
    writeFileSync(
      path.join(ctx.paths.amendmentsDir(ctx.meta.runId), `${result.amendment.id}.json`),
      JSON.stringify(result.amendment, null, 2),
      "utf8",
    );
    const oldIds = new Set(currentPlan.tasks.map((t) => t.id));
    const added = amended.tasks.filter((t) => !oldIds.has(t.id)).map((t) => t.id);
    for (const id of added) {
      ctx.state = { ...ctx.state, tasks: { ...ctx.state.tasks, [id]: { taskId: id, status: "pending", attempt: 0 } } };
    }
    currentPlan = amended;
    ctx.plan = amended;
    ctx.events.append("PLAN_AMENDED", {
      amendmentId: result.amendment.id,
      planDigest: computePlanDigest(amended),
      removedTaskIds: [...oldIds].filter((id) => !amended.tasks.some((t) => t.id === id)),
      addedTaskIds: added,
      operations: result.amendment.operations.map((o) => o.op),
    });
    ctx.state = { ...ctx.state, replans: ctx.state.replans + 1 };
    persistState(ctx.paths.stateFile(ctx.meta.runId), ctx.state);
    return "amended";
  };

  const runOne = async (task: Task): Promise<void> => {
    try {
      const prior = ctx.state.tasks[task.id];
      const attempt = (prior?.attempt ?? 0) + 1;
      transition(task.id, {
        taskId: task.id,
        status: "running",
        attempt,
        startedAt: ctx.now(),
        ...(prior?.failure ? { failure: prior.failure } : {}),
      });

      // Per-task isolation, branched from the integration HEAD at launch.
      const startPoint = currentRevision(integration);
      const wt = createWorktree(
        ctx.paths.repoRoot,
        ctx.meta.specId,
        `${ctx.meta.runId}--${task.id}`,
        ctx.paths.worktreesDir,
        { startPoint },
      );
      let outcome: ExecutionOutcome;
      try {
        outcome = await executeTaskInRun(
          ctx,
          usageSink,
          task,
          attempt,
          attempt > 1 && prior?.failure ? { code: prior.failure.code, message: prior.failure.message } : undefined,
          wt.path,
        );
        // Merge the task patch deterministically into the integration branch.
        const sha = commitAll(wt.path, `spc: task ${task.id} (run ${ctx.meta.runId})`);
        if (sha) {
          const merged = mergeTaskPatch(integration, sha);
          if (!merged.ok) {
            ctx.events.append("EXECUTION_CONFLICT", {
              taskId: task.id,
              revision: sha,
              message: "task patch conflicted during deterministic merge",
            });
            outcome = failedOutcome(task, "EXECUTION_CONFLICT", "task patch conflicted during deterministic merge");
          } else {
            ctx.events.append("PATCH_MERGED", { taskId: task.id, revision: sha });
          }
        }
      } finally {
        removeWorktree(ctx.paths.repoRoot, wt.path);
      }

      switch (outcome.status) {
        case "completed":
          transition(task.id, {
            taskId: task.id,
            status: "completed",
            attempt,
            startedAt: ctx.now(),
            completedAt: ctx.now(),
          });
          break;
        case "failed": {
          const failure = outcome.failure ?? { code: "TASK_FAILED", message: outcome.summary };
          if (attempt - 1 < ctx.config.execution.maxTaskRetries) {
            transition(task.id, { taskId: task.id, status: "pending", attempt, failure });
          } else {
            transition(task.id, { taskId: task.id, status: "failed", attempt, failure });
            failedTasks.push(task.id);
          }
          break;
        }
        case "blocked":
          transition(task.id, {
            taskId: task.id,
            status: "blocked",
            attempt,
            failure: outcome.failure ?? { code: "TASK_BLOCKED", message: outcome.summary },
          });
          break;
        case "needs_replan": {
          transition(task.id, { taskId: task.id, status: "needs_replan", attempt });
          const r = await replanFor(task.id);
          if (r !== "amended") schedulerOutcome = "replan_failed";
          break;
        }
      }
    } finally {
      inFlight.delete(task.id);
      inFlightWrites.delete(task.id);
    }
  };

  for (;;) {
    const plan = currentPlan;
    const stateOf = (id: string): TaskState => ctx.state.tasks[id] ?? { taskId: id, status: "pending", attempt: 0 };

    for (const t of plan.tasks) {
      if (stateOf(t.id).status === "running") {
        transition(t.id, { ...stateOf(t.id), status: "pending" });
      }
    }
    for (const t of plan.tasks) {
      if (stateOf(t.id).status !== "pending") continue;
      const blockedDeps = (t.dependsOn ?? []).filter((d) => BLOCKING.has(stateOf(d).status));
      if (blockedDeps.length > 0) {
        transition(t.id, { ...stateOf(t.id), status: "blocked" });
      }
    }

    const pending = plan.tasks.filter((t) => stateOf(t.id).status === "pending" && !inFlight.has(t.id));
    if (pending.length === 0 && inFlight.size === 0) break;

    const ready = pending.filter((t) =>
      (t.dependsOn ?? []).every((d) => stateOf(d).status === "completed" || stateOf(d).status === "skipped"),
    );
    if (ready.length > 0) {
      for (const task of ready) {
        if (inFlight.size >= maxParallel) break;
        const writes = task.targets?.write ?? [];
        const overlaps = [...inFlightWrites.values()].some(
          (other) => writes.length > 0 && other.length > 0 && writes.some((w) => other.some((o) => patternsOverlap(w, o))),
        );
        if (overlaps) continue; // stays pending; ordering dependency or later round
        inFlightWrites.set(task.id, writes);
        inFlight.set(task.id, runOne(task));
      }
    }
    if (inFlight.size === 0) {
      if (pending.length > 0) {
        schedulerOutcome = "deadlocked";
        break;
      }
      break;
    }
    await Promise.race([...inFlight.values()]);
  }
  while (inFlight.size > 0) await Promise.race([...inFlight.values()]);

  return finishRun(ctx, currentPlan, usageSink, schedulerOutcome, failedTasks);
}

export { failedOutcome };

/**
 * Deterministically merge a committed task patch into the integration
 * branch. Because task worktrees are cut from the post-merge HEAD and
 * overlapping writers are gated, conflicts are structurally prevented; this
 * handler is defense-in-depth for the cases that slip through (e.g. deletes
 * racing modifies) and never resolves conflicts silently.
 */
export function mergeTaskPatch(integrationWorktree: string, sha: string): { ok: boolean } {
  const pick = git(integrationWorktree, ["cherry-pick", sha]);
  if (pick.ok) return { ok: true };
  git(integrationWorktree, ["cherry-pick", "--abort"]);
  git(integrationWorktree, ["reset", "--hard", "HEAD"]);
  return { ok: false };
}

function failedOutcome(task: Task, code: string, message: string): ExecutionOutcome {
  return {
    taskId: task.id,
    status: "failed",
    summary: message,
    result: { status: "failed", summary: message, changes: [], observations: [], evidenceCandidates: [], followups: [] },
    appliedChanges: [],
    failure: { code, message },
  };
}

async function finalize(
  ctx: RunContext,
  status: RunStatus,
  requirementStates: RequirementState[],
  extra: { resultRevision?: string; diffStat?: string; changedFileCount?: number } = {},
): Promise<ApplyReport> {
  ctx.state = {
    ...ctx.state,
    status,
    ...(extra.resultRevision ? { resultRevision: extra.resultRevision } : {}),
    requirements: {
      ...ctx.state.requirements,
      ...Object.fromEntries(requirementStates.map((s) => [s.propertyId, s])),
    },
  };
  ctx.events.append("RUN_COMPLETED", {
    status,
    ...(extra.resultRevision ? { resultRevision: extra.resultRevision } : {}),
    requirements: Object.fromEntries(
      (requirementStates.length > 0 ? requirementStates : Object.values(ctx.state.requirements)).map((s) => [
        s.propertyId,
        s.status,
      ]),
    ),
  });
  persistState(ctx.paths.stateFile(ctx.meta.runId), ctx.state);

  const specIrForSummary = ctx.specIr;
  const summary = renderRunSummary({
    specIr: specIrForSummary,
    runState: ctx.state,
    followups: [...ctx.followups.all()],
    evidence: [...ctx.evidence.all()],
    ...(extra.diffStat ? { diffStat: extra.diffStat } : {}),
    ...(extra.changedFileCount !== undefined ? { changedFileCount: extra.changedFileCount } : {}),
  });
  writeFileSync(ctx.paths.summaryFile(ctx.meta.runId), summary, "utf8");

  return {
    status,
    runId: ctx.meta.runId,
    runDir: ctx.paths.runDir(ctx.meta.runId),
    ...(ctx.worktreePath ? { worktree: ctx.worktreePath } : {}),
    ...(ctx.worktreeBranch ? { branch: ctx.worktreeBranch } : {}),
    ...(ctx.state.baseRevision ? { baseRevision: ctx.state.baseRevision } : {}),
    ...(extra.resultRevision ? { resultRevision: extra.resultRevision } : {}),
    requirements:
      requirementStates.length > 0 ? requirementStates : Object.values(ctx.state.requirements),
    followups: [...ctx.followups.all()],
    modelCalls: ctx.modelCalls,
    replans: ctx.state.replans,
    ...(extra.diffStat ? { diffStat: extra.diffStat } : {}),
    ...(extra.changedFileCount !== undefined ? { changedFileCount: extra.changedFileCount } : {}),
    summaryPath: ctx.paths.summaryFile(ctx.meta.runId),
  };
}
