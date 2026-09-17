import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileSpecSource, SpcError } from "@spc/core";
import type { LLMProvider, UsageRecord } from "@spc/llm";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { generatePlan } from "@spc/planner";
import { applyPlan, newPlanId, spcPaths, type ApplyReport } from "@spc/runtime";
import { commitAll, observeRepository } from "@spc/repo";
import type { LoadedTask } from "./task.js";

/**
 * Treatment arm (§66): the same task flows through SpecIR → validated PlanIR
 * → bounded execution → verification → evidence. Runs the exact runtime the
 * `spc` CLI drives (generatePlan + applyPlan).
 */

export interface TreatmentResult {
  report: ApplyReport;
  /** Repository state to grade: the run worktree, or the untouched copy when blocked. */
  gradeRepoDir: string;
  replanReasons: string[];
  tokensIn: number;
  tokensOut: number;
}

const RUNTIME_STATE_GITIGNORE = ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n";

export async function runTreatmentArm(options: {
  task: LoadedTask;
  repoDir: string;
  /** Injected real provider; when absent the scripted fake is used. */
  provider?: LLMProvider;
  repoFiles?: { path: string; content: string }[];
}): Promise<TreatmentResult> {
  const { task, repoDir } = options;
  const real = options.provider ?? null;

  const compile = compileSpecSource(task.task.spec, "specs/spec.yaml");
  if (!compile.ok || !compile.ir) {
    throw new SpcError("EVAL_TASK_INVALID", `task ${task.task.id}: embedded spec is invalid: ${compile.diagnostics.map((d) => d.message).join("; ")}`);
  }
  const specIr = compile.ir;
  const paths = spcPaths(repoDir);

  mkdirSync(path.join(repoDir, "specs"), { recursive: true });
  writeFileSync(path.join(repoDir, "specs", "spec.yaml"), task.task.spec, "utf8");
  mkdirSync(path.join(repoDir, ".spc"), { recursive: true });
  if (!real) {
    writeFileSync(path.join(repoDir, ".spc", "fake-script.yaml"), readFileSync(task.treatmentScriptPath, "utf8"), "utf8");
  }
  writeFileSync(
    path.join(repoDir, ".spc", "config.yaml"),
    real
      ? ["version: 1", "provider:", `  name: ${real.name}`, `  model: ${real.model}`].join("\n")
      : ["version: 1", "provider:", "  name: fake", "  script: .spc/fake-script.yaml"].join("\n"),
    "utf8",
  );
  appendGitignore(repoDir);
  // The spec/config files must not dirty the tree: apply's preflight
  // refuses dirty repositories by design.
  commitAll(repoDir, `benchmark setup: ${task.task.id}`);

  const provider = real ?? new FakeProvider(parseFakeScript(readFileSync(task.treatmentScriptPath, "utf8")));

  const snapshot = observeRepository(repoDir, specIr);
  const planId = newPlanId(paths.plansDir);
  mkdirSync(paths.plansDir, { recursive: true });
  const excerpts =
    options.repoFiles ?? snapshot.relevantArtifacts.slice(0, 6).map((a) => ({ path: a.path, content: "" }));
  let tokensIn = 0;
  let tokensOut = 0;
  const generated = await generatePlan({
    specIr,
    snapshot,
    excerpts,
    provider,
    planId,
    onUsage: (record) => {
      tokensIn += record.inputTokens ?? 0;
      tokensOut += record.outputTokens ?? 0;
    },
  });
  if (!generated.plan) {
    throw new SpcError(
      "EVAL_TREATMENT_FAILED",
      `task ${task.task.id}: scripted planner failed validation: ${generated.diagnostics.map((d) => d.message).join("; ")}`,
    );
  }
  writeFileSync(paths.planFile(planId), JSON.stringify(generated.plan, null, 2), "utf8");

  const report = await applyPlan({ repoRoot: repoDir, planFile: paths.planFile(planId) }, {
    providerFactory: async () => provider,
    log: () => {},
  });
  // Runtime usage records cover executor/verifier/replanner calls.
  try {
    const usageText = readFileSync(paths.usageFile(report.runId), "utf8");
    for (const line of usageText.trim().split("\n").filter((l) => l !== "")) {
      const record = JSON.parse(line) as { inputTokens?: number; outputTokens?: number };
      tokensIn += record.inputTokens ?? 0;
      tokensOut += record.outputTokens ?? 0;
    }
  } catch {
    // no usage file (blocked before execution)
  }

  const replanReasons: string[] = [];
  try {
    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    for (const line of events.trim().split("\n")) {
      const e = JSON.parse(line) as { type: string; payload?: { reason?: unknown; observationIds?: unknown } };
      if (e.type === "REPLAN_REQUESTED") {
        replanReasons.push(String(e.payload?.reason ?? e.payload?.observationIds ?? "replan"));
      }
    }
  } catch {
    // no events file (should not happen) — leave reasons empty
  }

  return {
    report,
    gradeRepoDir: report.worktree ?? repoDir,
    replanReasons,
    tokensIn,
    tokensOut,
  };
}

function appendGitignore(repoDir: string): void {
  const file = path.join(repoDir, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = RUNTIME_STATE_GITIGNORE.trim().split("\n").filter((l) => !current.split("\n").includes(l));
  if (missing.length > 0) appendFileSync(file, `${missing.join("\n")}\n`, "utf8");
}
