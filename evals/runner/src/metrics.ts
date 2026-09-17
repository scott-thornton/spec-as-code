import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { globMatchAny } from "@spc/core";
import { evaluateCommandPolicy } from "@spc/executor";
import { DEFAULT_CONFIG } from "@spc/schema";
import type { VerifyCheck } from "./task.js";

/**
 * Ground-truth grading. Neither arm's self-reporting is consulted: grading
 * copies withheld checks into the resulting repository and measures state.
 */

export interface ArmOutcome {
  /** Repository working tree to grade. */
  repoDir: string;
  /** Base revision for diff-based metrics, or null when nothing executed. */
  baseRevision: string | null;
  resultRevision: string | null;
  /** Baseline-agent claims (control arm only). */
  claimedDone: boolean;
  /** spc run status (treatment arm only). */
  spcStatus: string | null;
}

export interface RequirementGrade {
  id: string;
  description: string;
  satisfied: boolean;
  detail: string;
}

export interface ArmMetrics {
  requirements: RequirementGrade[];
  completionRate: number;
  regression: { command: string; passedAfter: boolean } | null;
  regressionsIntroduced: boolean;
  forbiddenChanges: string[];
  patchSize: number;
  falseCompletionDeclaration: boolean;
}

const COMMAND_TIMEOUT_MS = 60_000;

export interface CommandOutcome {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
}

export function runCommandIn(cwd: string, command: string): CommandOutcome {
  const r = spawnSync(command, {
    shell: true,
    cwd,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { exitCode: r.status, timedOut, stdout: r.stdout ?? "" };
}

export function runCheck(check: VerifyCheck, cwd: string): { satisfied: boolean; detail: string } {
  if (check.type === "command") {
    const decision = evaluateCommandPolicy(check.command, DEFAULT_CONFIG.commands);
    if (!decision.allowed) return { satisfied: false, detail: `command denied by policy: ${decision.reason}` };
    const r = runCommandIn(cwd, check.command);
    const satisfied = !r.timedOut && r.exitCode === check.expectExitCode;
    return { satisfied, detail: `exit=${r.exitCode}${r.timedOut ? " (timed out)" : ""}` };
  }
  const full = path.join(cwd, check.path);
  if (!existsSync(full) || !statSync(full).isFile()) {
    return { satisfied: false, detail: "file missing" };
  }
  const content = readFileSync(full, "utf8");
  if (check.contains !== undefined && !content.includes(check.contains)) {
    return { satisfied: false, detail: `missing "${check.contains}"` };
  }
  if (check.notContains !== undefined && content.includes(check.notContains)) {
    return { satisfied: false, detail: `contains forbidden "${check.notContains}"` };
  }
  return { satisfied: true, detail: "file check passed" };
}

export interface GradeArmInput {
  gradingDir: string | null;
  requirements: { id: string; description: string; verify: VerifyCheck }[];
  regressionCommand: string | undefined;
  passedBefore: boolean;
  forbidden: readonly string[];
  outcome: ArmOutcome;
}

export function gradeArm(input: GradeArmInput): ArmMetrics {
  // Withheld grading tests land in the result tree; diff-based metrics
  // exclude them (and the control arm's PLAN.md) so patches compare work,
  // not grading scaffolding.
  if (input.gradingDir) {
    cpSync(input.gradingDir, input.outcome.repoDir, { recursive: true });
  }

  const grades: RequirementGrade[] = input.requirements.map((r) => {
    const { satisfied, detail } = runCheck(r.verify, input.outcome.repoDir);
    return { id: r.id, description: r.description, satisfied, detail };
  });
  const satisfiedCount = grades.filter((g) => g.satisfied).length;
  const completionRate = grades.length === 0 ? 0 : satisfiedCount / grades.length;

  let regression: ArmMetrics["regression"] = null;
  let regressionsIntroduced = false;
  if (input.regressionCommand) {
    const after = runCommandIn(input.outcome.repoDir, input.regressionCommand);
    const passedAfter = !after.timedOut && after.exitCode === 0;
    regression = { command: input.regressionCommand, passedAfter };
    regressionsIntroduced = input.passedBefore && !passedAfter;
  }

  let forbiddenChanges: string[] = [];
  let patchSize = 0;
  const { baseRevision, resultRevision, repoDir } = input.outcome;
  if (baseRevision && resultRevision && baseRevision !== resultRevision) {
    const names = runCommandIn(repoDir, `git diff --name-only ${baseRevision}..${resultRevision}`)
      .stdout.split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("grading/") && l !== "PLAN.md");
    forbiddenChanges = names.filter((n) => globMatchAny(input.forbidden, n));
    const numstat = runCommandIn(repoDir, `git diff --numstat ${baseRevision}..${resultRevision}`).stdout;
    for (const line of numstat.split("\n")) {
      const [add, del] = line.split("\t");
      patchSize += (Number(add) || 0) + (Number(del) || 0);
    }
  }

  const falseCompletionDeclaration =
    completionRate < 1 && (input.outcome.claimedDone || input.outcome.spcStatus === "succeeded");

  return {
    requirements: grades,
    completionRate,
    regression,
    regressionsIntroduced,
    forbiddenChanges,
    patchSize,
    falseCompletionDeclaration,
  };
}
