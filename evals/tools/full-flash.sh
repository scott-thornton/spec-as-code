#!/bin/zsh
# Full 30-task benchmark on glm-5.3-flash, post-fix code, both arms,
# concurrency 3 + sequential retry wave + merge for aggregation.
set -u
cd "$(dirname "$0")/../.."
: "${GLM_API_KEY:?export GLM_API_KEY before running}"
RUNNER=evals/runner/dist/main.js
OUT=evals/results/full-flash-fixed
rm -rf "$OUT"; mkdir -p "$OUT"
TASKS=($(find evals/tasks -name task.yaml | sed -E 's|.*/tasks/[^/]+/([^/]+)/task.yaml|\1|' | sort))
echo "=== full flash (fixed code) start: ${#TASKS} tasks $(date +%H:%M)" >> "$OUT/progress.log"
for id in $TASKS; do
  while (( $(jobs -r | wc -l) >= 3 )); do wait -n; done
  node $RUNNER --tasks evals/tasks --task $id --out "$OUT/$id" \
    --provider anthropic --model glm-5.3-flash \
    --base-url https://api.z.ai/api/anthropic --api-key-env GLM_API_KEY \
    --timeout-ms 180000 > "$OUT/$id.log" 2>&1 &
done
wait
for id in $TASKS; do
  if ! grep -q "Benchmark complete: 1 task result(s), 0 error(s)" "$OUT/$id.log" 2>/dev/null; then
    echo "retry $id $(date +%H:%M:%S)" >> "$OUT/progress.log"
    node $RUNNER --tasks evals/tasks --task $id --out "$OUT/$id" \
      --provider anthropic --model glm-5.3-flash \
      --base-url https://api.z.ai/api/anthropic --api-key-env GLM_API_KEY \
      --timeout-ms 180000 > "$OUT/$id.log" 2>&1
  fi
done
node -e "
const {readFileSync, writeFileSync, mkdirSync} = require('node:fs');
const {readdirSync} = require('node:fs');
const ids = readdirSync('evals/results/full-flash-fixed').filter(f => !f.includes('.')).sort();
const merged = [];
for (const id of ids) {
  try { merged.push(...JSON.parse(readFileSync('evals/results/full-flash-fixed/' + id + '/results.json', 'utf8')).results); }
  catch (e) { console.error('missing', id); }
}
merged.sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
mkdirSync('evals/results/full-flash-fixed-merged', {recursive: true});
writeFileSync('evals/results/full-flash-fixed-merged/results.json', JSON.stringify({mode: 'real', trials: 1, generatedAt: new Date().toISOString(), results: merged}, null, 2));
console.log('merged', merged.length, 'results,', merged.filter(r => r.error).length, 'errors');
" >> "$OUT/progress.log" 2>&1
echo "=== FULL FLASH COMPLETE $(date +%H:%M)" >> "$OUT/progress.log"
