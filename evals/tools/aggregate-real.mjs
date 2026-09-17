/**
 * Aggregate repeated real-mode benchmark trials: per-trial headline metrics,
 * mean ± standard deviation across trials, per-task stability, and proposed
 * §68 acceptance thresholds derived from the observed variance.
 *
 *   node evals/tools/aggregate-real.mjs evals/results/real-glm-4.6-t1 ... > report.md
 */
import { readFileSync } from "node:fs";

const trialPaths = process.argv.slice(2);
if (trialPaths.length === 0) {
  console.error("usage: aggregate-real.mjs <trial-results.json | trial-dir>...");
  process.exit(2);
}

const trials = trialPaths.map((p) =>
  p.endsWith(".json") ? JSON.parse(readFileSync(p, "utf8")) : JSON.parse(readFileSync(`${p}/results.json`, "utf8")),
);

function arm(trial, name) {
  return trial.results.filter((r) => !r.error).map((r) => r[name]);
}

const metricFns = {
  completion: (a) => a.completionRate,
  falseDone: (a) => (a.falseCompletionDeclaration ? 1 : 0),
  regression: (a) => (a.regressionsIntroduced ? 1 : 0),
  forbidden: (a) => a.forbiddenChanges.length,
  patch: (a) => a.patchSize,
  calls: (a) => a.modelCalls,
  tokensIn: (a) => a.tokensIn ?? 0,
  tokensOut: (a) => a.tokensOut ?? 0,
};

function stats(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, sd: Math.sqrt(variance) };
}

function fmt(x) {
  return Number.isInteger(x) ? String(x) : (Math.round(x * 1000) / 1000).toString();
}

const lines = [];
lines.push("# Real-model benchmark — aggregate over trials", "");
lines.push(`- Trials: ${trials.length} (${trialPaths.join(", ")})`);
lines.push(`- Tasks per trial: ${trials[0].results.length}`);
lines.push(`- Mode: ${trials[0].mode}`);
lines.push("");

lines.push("## Per-trial headline", "");
lines.push("| Trial | Tasks (ok) | Ctrl completion | spc completion | Ctrl false-done | spc false-done | Ctrl regr | spc regr | Ctrl forb | spc forb | Ctrl tok in/out | spc tok in/out |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
const perTrial = trials.map((t, i) => {
  const ctrl = arm(t, "control");
  const trt = arm(t, "treatment");
  const sum = (arr, f) => arr.reduce((a, r) => a + f(r), 0);
  const row = {
    ok: ctrl.length,
    ctrlCompletion: sum(ctrl, metricFns.completion) / (ctrl.length || 1),
    trtCompletion: sum(trt, metricFns.completion) / (trt.length || 1),
    ctrlFalse: sum(ctrl, metricFns.falseDone),
    trtFalse: sum(trt, metricFns.falseDone),
    ctrlRegr: sum(ctrl, metricFns.regression),
    trtRegr: sum(trt, metricFns.regression),
    ctrlForb: sum(ctrl, metricFns.forbidden),
    trtForb: sum(trt, metricFns.forbidden),
    ctrlTok: [sum(ctrl, metricFns.tokensIn), sum(ctrl, metricFns.tokensOut)],
    trtTok: [sum(trt, metricFns.tokensIn), sum(trt, metricFns.tokensOut)],
  };
  lines.push(
    `| ${i + 1} | ${row.ok} | ${(row.ctrlCompletion * 100).toFixed(0)}% | ${(row.trtCompletion * 100).toFixed(0)}% | ${row.ctrlFalse} | ${row.trtFalse} | ${row.ctrlRegr} | ${row.trtRegr} | ${row.ctrlForb} | ${row.trtForb} | ${row.ctrlTok[0].toLocaleString()}/${row.ctrlTok[1].toLocaleString()} | ${row.trtTok[0].toLocaleString()}/${row.trtTok[1].toLocaleString()} |`,
  );
  return row;
});
lines.push("");

lines.push("## Variance across trials (mean ± sd)", "");
lines.push("| Metric | Control | spc workflow |", "| --- | --- | --- |");
const ctrlAgg = perTrial.map((r) => ({ completion: r.ctrlCompletion, false: r.ctrlFalse, regr: r.ctrlRegr, forb: r.ctrlForb }));
const trtAgg = perTrial.map((r) => ({ completion: r.trtCompletion, false: r.trtFalse, regr: r.trtRegr, forb: r.trtForb }));
for (const [label, key] of [["Completion rate", "completion"], ["False completions", "false"], ["Regressions", "regr"], ["Forbidden modifications", "forb"]]) {
  const c = stats(ctrlAgg.map((r) => r[key]));
  const t = stats(trtAgg.map((r) => r[key]));
  lines.push(`| ${label} | ${fmt(c.mean)} ± ${fmt(c.sd)} | ${fmt(t.mean)} ± ${fmt(t.sd)} |`);
}
lines.push("");

// Per-task stability across trials.
lines.push("## Per-task stability (completion per trial)", "");
const taskIds = [...new Set(trials[0].results.map((r) => r.taskId))];
lines.push("| Task | Ctrl | spc | spc status |", "| --- | --- | --- | --- |");
for (const id of taskIds) {
  const cells = { ctrl: [], trt: [], status: [] };
  for (const t of trials) {
    const r = t.results.find((x) => x.taskId === id);
    if (!r || r.error) {
      cells.ctrl.push("ERR");
      cells.trt.push("ERR");
      cells.status.push("error");
      continue;
    }
    cells.ctrl.push((r.control.completionRate * 100).toFixed(0));
    cells.trt.push((r.treatment.completionRate * 100).toFixed(0));
    cells.status.push(r.treatment.status);
  }
  lines.push(`| ${id} | ${cells.ctrl.join("/")} | ${cells.trt.join("/")} | ${cells.status.join("/")} |`);
}
lines.push("");

// Proposed thresholds from observed variance (§68).
const cComp = stats(ctrlAgg.map((r) => r.completion));
const tComp = stats(trtAgg.map((r) => r.completion));
const tFalse = stats(trtAgg.map((r) => r.false));
const cFalse = stats(ctrlAgg.map((r) => r.false));
const delta = tComp.mean - cComp.mean;
const pooled = Math.sqrt((cComp.sd ** 2 + tComp.sd ** 2) / 2) || 0.0001;
lines.push("## Proposed §68 acceptance thresholds (derived from observed variance)", "");
lines.push(`- Observed completion delta (spc − control): **${(delta * 100).toFixed(1)} pp** (pooled sd ${(pooled * 100).toFixed(1)} pp).`);
lines.push(`- With n=${trials.length} trials this is a descriptive result, not a significance test; treat thresholds below as reviewable engineering gates, and re-derive them as n grows.`);
lines.push("");
lines.push("Continue investing in the workflow only while ALL hold:");
lines.push(`1. spc completion ≥ control completion + ${Math.max(5, Math.ceil(pooled * 100)).toFixed(0)} pp (delta above noise).`);
lines.push(`2. spc false completions ≤ ${Math.max(0, Math.ceil(cFalse.mean))} (never worse than baseline).`);
lines.push(`3. spc regressions + forbidden modifications ≤ control on every trial.`);
const ctrlTokTotal = perTrial.reduce((a, r) => a + r.ctrlTok[0] + r.ctrlTok[1], 0);
const trtTokTotal = perTrial.reduce((a, r) => a + r.trtTok[0] + r.trtTok[1], 0);
const overhead = ctrlTokTotal > 0 ? trtTokTotal / ctrlTokTotal : 0;
lines.push(`4. spc token overhead ≤ 3× control (observed: ${overhead.toFixed(2)}×).`);
lines.push("");
console.log(lines.join("\n"));
