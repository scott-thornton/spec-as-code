#!/bin/zsh
# Fast adversarial gate, glm-5.3-flash via API: 12 tasks, concurrency 3,
# one sequential retry wave for rate-limit casualties, merge for aggregation.
set -u
cd "$(dirname "$0")/../.."
: "${GLM_API_KEY:?export GLM_API_KEY before running}"
RUNNER=evals/runner/dist/main.js
OUT=evals/results/flashgate
TASKS=(feat-log-levels refactor-rename-internal api-optional-param test-add-coverage test-fix-expectation test-edge-cases mono-shared-const mono-cross-feature mono-version-bump api-deprecate-field api-version-header sec-remove-eval)
rm -rf "$OUT"; mkdir -p "$OUT"
echo "=== flash gate start $(date +%H:%M)" >> "$OUT/progress.log"
for id in $TASKS; do
  while (( $(jobs -r | wc -l) >= 3 )); do wait -n; done
  node $RUNNER --tasks evals/tasks --task $id --out "$OUT/$id" \
    --provider anthropic --model glm-5.3-flash \
    --base-url https://api.z.ai/api/anthropic --api-key-env GLM_API_KEY \
    --timeout-ms 180000 > "$OUT/$id.log" 2>&1 &
done
wait
# sequential retry wave for any task that errored (rate limits etc.)
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
const ids = process.argv.slice(1);
const merged = [];
for (const id of ids) {
  try { merged.push(...JSON.parse(readFileSync('evals/results/flashgate/' + id + '/results.json', 'utf8')).results); }
  catch (e) { console.error('missing', id); }
}
merged.sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
mkdirSync('evals/results/flashgate-merged', {recursive: true});
writeFileSync('evals/results/flashgate-merged/results.json', JSON.stringify({mode: 'real', trials: 1, generatedAt: new Date().toISOString(), results: merged}, null, 2));
console.log('merged', merged.length);
" $TASKS >> "$OUT/progress.log" 2>&1
echo "=== FLASH GATE COMPLETE $(date +%H:%M)" >> "$OUT/progress.log"
