#!/bin/zsh
# Full 30-task benchmark in harness mode: a coding agent in this repository
# answers every model request through files. Zero API cost. Sequential.
set -u
cd "$(dirname "$0")/../.."
RUNNER=evals/runner/dist/main.js
OUT=evals/results/full-harness
HARNESS=evals/results/harness-reqs
rm -rf "$OUT"; rm -rf "$HARNESS"; mkdir -p "$OUT" "$HARNESS"
TASKS=($(find evals/tasks -name task.yaml | sed -E 's|.*/tasks/[^/]+/([^/]+)/task.yaml|\1|' | sort))
echo "=== full harness gate start: ${#TASKS} tasks $(date +%H:%M)" >> "$OUT/progress.log"
for id in $TASKS; do
  echo "task $id start $(date +%H:%M:%S)" >> "$OUT/progress.log"
  node $RUNNER --tasks evals/tasks --task $id --out "$OUT/$id" \
    --provider harness --harness-dir "$HARNESS" --timeout-ms 600000 \
    > "$OUT/$id.log" 2>&1
  echo "task $id exit=$? $(date +%H:%M:%S)" >> "$OUT/progress.log"
done
node -e "
const {readFileSync, writeFileSync, mkdirSync, readdirSync} = require('node:fs');
const ids = readdirSync('evals/results/full-harness').filter(f => !f.includes('.')).sort();
const merged = [];
for (const id of ids) {
  try { merged.push(...JSON.parse(readFileSync('evals/results/full-harness/' + id + '/results.json', 'utf8')).results); }
  catch (e) { console.error('missing', id); }
}
merged.sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
mkdirSync('evals/results/full-harness-merged', {recursive: true});
writeFileSync('evals/results/full-harness-merged/results.json', JSON.stringify({mode: 'real', trials: 1, generatedAt: new Date().toISOString(), results: merged}, null, 2));
console.log('merged', merged.length, 'results,', merged.filter(r => r.error).length, 'errors');
" >> "$OUT/progress.log" 2>&1
echo "=== FULL HARNESS COMPLETE $(date +%H:%M)" >> "$OUT/progress.log"
