import type { BenchmarkResult, TaskResult } from "./benchmark.js";

/** Aggregate + render the comparison report (§66–§68 metrics). */

export interface CategoryRow {
  category: string;
  tasks: number;
  controlCompletion: number;
  treatmentCompletion: number;
  controlFalseCompletions: number;
  treatmentFalseCompletions: number;
  controlRegressions: number;
  treatmentRegressions: number;
  controlForbidden: number;
  treatmentForbidden: number;
}

export interface ArmTotals {
  meanCompletion: number;
  falseCompletions: number;
  regressions: number;
  forbiddenChanges: number;
  patchSize: number;
  modelCalls: number;
  blocked: number;
  replans: number;
  followupsRaised: number;
}

export function armTotals(results: TaskResult[], arm: "control" | "treatment"): ArmTotals {
  const pick = arm === "control" ? (r: TaskResult) => r.control : (r: TaskResult) => r.treatment;
  const valid = results.filter((r) => !r.error);
  const n = valid.length;
  const sum = (f: (r: TaskResult) => number): number => valid.reduce((a, r) => a + f(r), 0);
  return {
    meanCompletion: n === 0 ? 0 : sum((r) => pick(r).completionRate) / n,
    falseCompletions: sum((r) => (pick(r).falseCompletionDeclaration ? 1 : 0)),
    regressions: sum((r) => (pick(r).regressionsIntroduced ? 1 : 0)),
    forbiddenChanges: sum((r) => pick(r).forbiddenChanges.length),
    patchSize: sum((r) => pick(r).patchSize),
    modelCalls: sum((r) => pick(r).modelCalls),
    blocked: sum((r) => (arm === "treatment" && r.treatment.status === "blocked" ? 1 : 0)),
    replans: sum((r) => (arm === "treatment" ? r.treatment.replans : 0)),
    followupsRaised: sum((r) => (arm === "treatment" ? r.treatment.followupsRaised : 0)),
  };
}

export function categoryRows(results: TaskResult[]): CategoryRow[] {
  const byCategory = new Map<string, TaskResult[]>();
  for (const r of results) {
    if (r.error) continue;
    const list = byCategory.get(r.category) ?? [];
    list.push(r);
    byCategory.set(r.category, list);
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) => {
      const c = armTotals(list, "control");
      const t = armTotals(list, "treatment");
      return {
        category,
        tasks: list.length,
        controlCompletion: c.meanCompletion,
        treatmentCompletion: t.meanCompletion,
        controlFalseCompletions: c.falseCompletions,
        treatmentFalseCompletions: t.falseCompletions,
        controlRegressions: c.regressions,
        treatmentRegressions: t.regressions,
        controlForbidden: c.forbiddenChanges,
        treatmentForbidden: t.forbiddenChanges,
      };
    });
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

export function renderSummary(result: BenchmarkResult): string {
  const control = armTotals(result.results, "control");
  const treatment = armTotals(result.results, "treatment");
  const lines: string[] = [];
  lines.push(`# spc benchmark — ${result.mode} mode`, "");
  lines.push(`- Tasks: ${result.results.length} (${result.trials} trial(s) each)`);
  lines.push(`- Date: ${result.generatedAt}`);
  lines.push("");
  lines.push("## Headline (mean over tasks)", "");
  lines.push("| Metric | Markdown-plan baseline | spc workflow |", "| --- | --- | --- |");
  lines.push(`| MUST requirement completion | ${pct(control.meanCompletion)} | ${pct(treatment.meanCompletion)} |`);
  lines.push(`| False completion declarations | ${control.falseCompletions} | ${treatment.falseCompletions} |`);
  lines.push(`| Regressions introduced | ${control.regressions} | ${treatment.regressions} |`);
  lines.push(`| Forbidden modifications | ${control.forbiddenChanges} | ${treatment.forbiddenChanges} |`);
  lines.push(`| Total patch size | ${control.patchSize} | ${treatment.patchSize} |`);
  lines.push(`| Model calls | ${control.modelCalls} | ${treatment.modelCalls} |`);
  lines.push(`| Replans | n/a | ${treatment.replans} |`);
  lines.push(`| Human follow-ups raised | n/a | ${treatment.followupsRaised} |`);
  lines.push(`| Runs blocked pending human input | n/a | ${treatment.blocked} |`);
  lines.push("");

  lines.push("## By category", "");
  lines.push(
    "| Category | Tasks | Ctrl completion | spc completion | Ctrl false-done | spc false-done | Ctrl regr | spc regr | Ctrl forb | spc forb |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of categoryRows(result.results)) {
    lines.push(
      `| ${row.category} | ${row.tasks} | ${pct(row.controlCompletion)} | ${pct(row.treatmentCompletion)} | ${row.controlFalseCompletions} | ${row.treatmentFalseCompletions} | ${row.controlRegressions} | ${row.treatmentRegressions} | ${row.controlForbidden} | ${row.treatmentForbidden} |`,
    );
  }
  lines.push("");

  const traps = result.results.filter((r) => r.trap && !r.error);
  if (traps.length > 0) {
    lines.push("## Trap tasks", "");
    lines.push("| Task | Trap | Control outcome | spc outcome |", "| --- | --- | --- | --- |");
    for (const r of traps) {
      const ctrl = r.control.falseCompletionDeclaration
        ? "false completion"
        : r.control.completionRate < 1
          ? `incomplete (${pct(r.control.completionRate)})`
          : "complete";
      const trt =
        r.treatment.status === "blocked"
          ? `blocked, follow-up raised (no hallucination)`
          : r.treatment.completionRate < 1
            ? `incomplete (${pct(r.treatment.completionRate)})`
            : "complete";
      lines.push(`| ${r.taskId} | ${r.trap} | ${ctrl} | ${trt} |`);
    }
    lines.push("");
  }

  lines.push("## Per-task results", "");
  lines.push(
    "| Task | Category | Ctrl | spc | Ctrl done? | spc status | Ctrl regr | spc regr |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of result.results) {
    if (r.error) {
      lines.push(`| ${r.taskId} | ${r.category} | ERROR | ERROR | — | — | — | — |`);
      continue;
    }
    lines.push(
      `| ${r.taskId} | ${r.category} | ${pct(r.control.completionRate)} | ${pct(r.treatment.completionRate)} | ${r.control.claimedDone ? "claimed" : "not claimed"} | ${r.treatment.status} | ${r.control.regressionsIntroduced ? "yes" : "no"} | ${r.treatment.regressionsIntroduced ? "yes" : "no"} |`,
    );
  }
  lines.push("");

  if (result.mode === "scripted") {
    lines.push(
      "## Interpretation caveat",
      "",
      "This run used **scripted** providers: both arms' behaviours are deterministic",
      "re-enactments encoded in per-task fake scripts. It validates the harness",
      "mechanics (metrics, grading, comparison) and illustrates the failure modes the",
      "thesis predicts — it is NOT evidence about real models. Validating the thesis",
      "requires real-provider mode (`spc-evals --provider openai`) and repeated trials;",
      "acceptance thresholds are intentionally not set until that variance is measured",
      "(§68 of the project plan).",
      "",
    );
  }
  return lines.join("\n");
}
