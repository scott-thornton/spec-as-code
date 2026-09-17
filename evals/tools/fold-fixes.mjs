/**
 * Fold make-up task runs into a trial's results.json, replacing error rows.
 *
 *   node evals/tools/fold-fixes.mjs evals/results/real-glm53f-t2 evals/results/fixes/t2-*
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const [trialDir, ...fixDirs] = process.argv.slice(2);
if (!trialDir || fixDirs.length === 0) {
  console.error("usage: fold-fixes.mjs <trial-dir> <fix-dir>...");
  process.exit(2);
}
const trial = JSON.parse(readFileSync(path.join(trialDir, "results.json"), "utf8"));
let replaced = 0;
let stillBroken = 0;
for (const fixDir of fixDirs) {
  const file = path.join(fixDir, "results.json");
  if (!existsSync(file)) {
    console.error(`skip ${fixDir}: no results.json`);
    continue;
  }
  const fix = JSON.parse(readFileSync(file, "utf8"));
  for (const row of fix.results) {
    const idx = trial.results.findIndex((r) => r.taskId === row.taskId);
    if (idx === -1) continue;
    trial.results[idx] = row;
    replaced += 1;
  }
}
for (const r of trial.results) if (r.error) stillBroken += 1;
writeFileSync(path.join(trialDir, "results.json"), JSON.stringify(trial, null, 2), "utf8");
console.log(`folded ${replaced} fix row(s); ${stillBroken} error row(s) remain`);
