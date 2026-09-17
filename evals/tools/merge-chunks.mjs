/**
 * Merge per-category chunk results into one trial results.json.
 *
 *   node evals/tools/merge-chunks.mjs evals/results/chunks/t2-* > evals/results/real-glm53f-t2/results.json
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const chunkDirs = process.argv.slice(2);
if (chunkDirs.length === 0) {
  console.error("usage: merge-chunks.mjs <chunk-dir>...  (each contains results.json)");
  process.exit(2);
}
const merged = [];
let mode = "real";
let generatedAt = new Date().toISOString();
for (const dir of chunkDirs) {
  const file = dir.endsWith(".json") ? dir : path.join(dir, "results.json");
  if (!existsSync(file)) {
    console.error(`skipping ${dir}: no results.json`);
    continue;
  }
  const data = JSON.parse(readFileSync(file, "utf8"));
  mode = data.mode;
  generatedAt = data.generatedAt;
  merged.push(...data.results);
}
merged.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : a.taskId < b.taskId ? -1 : 1));
process.stdout.write(JSON.stringify({ mode, trials: 1, generatedAt, results: merged }, null, 2) + "\n");
