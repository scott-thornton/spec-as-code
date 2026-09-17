import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SpcError } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import type { LLMProvider } from "@spc/llm";
import { DEFAULT_BASELINE_INSTRUCTIONS, listTasks, type LoadedTask } from "./task.js";
import { runControlArm } from "./control.js";
import { runTreatmentArm } from "./treatment.js";
import { gradeArm, runCommandIn, type ArmMetrics } from "./metrics.js";
import { renderSummary } from "./compare.js";
import { boundedRepoDump } from "./context.js";

/**
 * Benchmark runner (§65–§67). For every task:
 *  - Control: same model, task + repo + Markdown planning instructions.
 *  - Treatment: the spc workflow (SpecIR → validated plan → bounded
 *    execution → verification → evidence), same provider.
 * Metrics are computed from withheld ground truth, never from either arm's
 * claims. `mode` records whether providers were scripted or real.
 */

export interface TaskArmResult extends ArmMetrics {
  modelCalls: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface ControlArmResult extends TaskArmResult {
  claimedDone: boolean;
}

export interface TreatmentArmResult extends TaskArmResult {
  status: string;
  replans: number;
  followupsRaised: number;
  replanReasons: string[];
}

export interface TaskResult {
  taskId: string;
  category: string;
  trap?: string;
  trial: number;
  control: ControlArmResult;
  treatment: TreatmentArmResult;
  error?: string;
}

export interface BenchmarkResult {
  mode: "scripted" | "real";
  trials: number;
  generatedAt: string;
  results: TaskResult[];
}

export interface BenchmarkOptions {
  tasksRoot: string;
  outDir: string;
  category?: string;
  taskFilter?: string;
  trials?: number;
  keepWork?: boolean;
  providerFactory?: (task: LoadedTask) => Promise<{ control: LLMProvider; treatment: LLMProvider }>;
}

const RUNTIME_GITIGNORE = [".spc/runs/", ".spc/worktrees/", ".spc/plans/"];

function prepareRepoCopy(task: LoadedTask, workDir: string): string {
  cpSync(task.repoDir, workDir, { recursive: true });
  gitOk(workDir, ["init", "-b", "main"]);
  const gitignore = path.join(workDir, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const missing = RUNTIME_GITIGNORE.filter((l) => !current.split("\n").includes(l));
  if (missing.length > 0) appendFileSync(gitignore, `${missing.join("\n")}\n`, "utf8");
  commitAll(workDir, `benchmark base: ${task.task.id}`);
  return workDir;
}

async function runOneTrial(task: LoadedTask, trial: number, workRoot: string, providerFactory: BenchmarkOptions["providerFactory"]): Promise<TaskResult> {
  const providers = providerFactory
    ? await providerFactory(task)
    : {
        control: new FakeProvider(parseFakeScript(readFileSync(task.controlScriptPath, "utf8"))),
        treatment: new FakeProvider(parseFakeScript(readFileSync(task.treatmentScriptPath, "utf8"))),
      };
  // Real models have no tool access: both arms receive the same bounded view
  // of the task repository.
  const repoFiles = providerFactory ? boundedRepoDump(task.repoDir) : undefined;

  // Harness sanity: the regression command must behave as declared pre-task.
  const sanityRepo = prepareRepoCopy(task, path.join(workRoot, `${task.task.id}-t${trial}-sanity`));
  let passedBefore = true;
  if (task.task.groundTruth.regression) {
    const r = runCommandIn(sanityRepo, task.task.groundTruth.regression.command);
    passedBefore = !r.timedOut && r.exitCode === 0;
    const expected = task.task.groundTruth.regression.expectBefore;
    if ((expected === "pass") !== passedBefore) {
      throw new SpcError(
        "EVAL_TASK_INVALID",
        `task ${task.task.id}: regression command expected to ${expected} before the task, but it ${passedBefore ? "passed" : "failed"}`,
      );
    }
  }
  rmSync(sanityRepo, { recursive: true, force: true });

  // Control arm.
  const controlRepo = prepareRepoCopy(task, path.join(workRoot, `${task.task.id}-t${trial}-control`));
  const controlRun = await runControlArm({
    task,
    repoDir: controlRepo,
    provider: providers.control,
    baselineInstructions: task.task.baselineInstructions ?? DEFAULT_BASELINE_INSTRUCTIONS,
    ...(repoFiles ? { repoFiles } : {}),
  });
  const controlMetrics = gradeArm({
    gradingDir: task.gradingDir,
    requirements: task.task.groundTruth.requirements,
    regressionCommand: task.task.groundTruth.regression?.command,
    passedBefore,
    forbidden: task.task.groundTruth.forbidden,
    outcome: {
      repoDir: controlRepo,
      baseRevision: controlRun.baseRevision,
      resultRevision: controlRun.resultRevision,
      claimedDone: controlRun.claimedDone,
      spcStatus: null,
    },
  });
  const control: ControlArmResult = {
    ...controlMetrics,
    modelCalls: controlRun.modelCalls,
    claimedDone: controlRun.claimedDone,
    tokensIn: controlRun.tokensIn,
    tokensOut: controlRun.tokensOut,
  };

  // Treatment arm.
  const treatmentRepo = prepareRepoCopy(task, path.join(workRoot, `${task.task.id}-t${trial}-treatment`));
  const treatmentRun = await runTreatmentArm({
    task,
    repoDir: treatmentRepo,
    provider: providers.treatment,
    ...(repoFiles ? { repoFiles } : {}),
  });
  const report = treatmentRun.report;
  const treatmentMetrics = gradeArm({
    gradingDir: task.gradingDir,
    requirements: task.task.groundTruth.requirements,
    regressionCommand: task.task.groundTruth.regression?.command,
    passedBefore,
    forbidden: task.task.groundTruth.forbidden,
    outcome: {
      repoDir: treatmentRun.gradeRepoDir,
      baseRevision: report.baseRevision ?? null,
      resultRevision: report.status === "blocked" ? report.baseRevision ?? null : report.resultRevision ?? null,
      claimedDone: false,
      spcStatus: report.status,
    },
  });
  const treatment: TreatmentArmResult = {
    ...treatmentMetrics,
    modelCalls: report.modelCalls,
    status: report.status,
    replans: report.replans,
    followupsRaised: report.followups.filter((f) => f.status === "open").length,
    replanReasons: treatmentRun.replanReasons,
    tokensIn: treatmentRun.tokensIn,
    tokensOut: treatmentRun.tokensOut,
  };

  return {
    taskId: task.task.id,
    category: task.task.category,
    ...(task.task.trap ? { trap: task.task.trap } : {}),
    trial,
    control,
    treatment,
  };
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const trials = options.trials ?? 1;
  let tasks = listTasks(options.tasksRoot, options.category);
  if (options.taskFilter) tasks = tasks.filter((t) => t.task.id === options.taskFilter);
  if (tasks.length === 0) throw new SpcError("EVAL_NO_TASKS", `no benchmark tasks found under ${options.tasksRoot}`);
  const workRoot = mkdtempSync(path.join(tmpdir(), "spc-evals-"));
  const results: TaskResult[] = [];

  for (const task of tasks) {
    for (let trial = 1; trial <= trials; trial++) {
      try {
        results.push(await runOneTrial(task, trial, workRoot, options.providerFactory));
      } catch (e) {
        results.push({
          taskId: task.task.id,
          category: task.task.category,
          ...(task.task.trap ? { trap: task.task.trap } : {}),
          trial,
          error: (e as Error).message,
          control: {
            requirements: [], completionRate: 0, regression: null, regressionsIntroduced: false,
            forbiddenChanges: [], patchSize: 0, falseCompletionDeclaration: false, modelCalls: 0, claimedDone: false,
          },
          treatment: {
            requirements: [], completionRate: 0, regression: null, regressionsIntroduced: false,
            forbiddenChanges: [], patchSize: 0, falseCompletionDeclaration: false, modelCalls: 0,
            status: "error", replans: 0, followupsRaised: 0, replanReasons: [],
          },
        });
      }
    }
  }

  const mode: "scripted" | "real" = options.providerFactory ? "real" : "scripted";
  const result: BenchmarkResult = {
    mode,
    trials,
    generatedAt: new Date().toISOString(),
    results,
  };

  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(path.join(options.outDir, "results.json"), JSON.stringify(result, null, 2), "utf8");
  writeFileSync(path.join(options.outDir, "summary.md"), renderSummary(result), "utf8");
  if (!options.keepWork) rmSync(workRoot, { recursive: true, force: true });
  return result;
}
