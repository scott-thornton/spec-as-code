#!/bin/zsh
# Fast adversarial gate, harness mode: the model is YOU (the coding agent),
# answering requests under HARNESS/.spc/harness. Zero API cost.
# Run this in the background, then answer requests until it completes.
set -u
cd "$(dirname "$0")/../.."
RUNNER=evals/runner/dist/main.js
OUT=evals/results/fastgate
HARNESS=evals/results/harness-reqs
TASKS=(feat-log-levels refactor-rename-internal api-optional-param test-add-coverage test-fix-expectation test-edge-cases mono-shared-const mono-cross-feature mono-version-bump api-deprecate-field api-version-header sec-remove-eval)
rm -rf "$OUT"; mkdir -p "$OUT"; mkdir -p "$HARNESS"
echo "=== harness gate start $(date +%H:%M)" >> "$OUT/progress.log"
for id in $TASKS; do
  echo "task $id start $(date +%H:%M:%S)" >> "$OUT/progress.log"
  node $RUNNER --tasks evals/tasks --task $id --out "$OUT/$id" \
    --provider harness --harness-dir "$HARNESS" --timeout-ms 600000 \
    > "$OUT/$id.log" 2>&1
  echo "task $id exit=$? $(date +%H:%M:%S)" >> "$OUT/progress.log"
done
# merge per-task results into one trial dir for aggregation
node -e "
const {readFileSync, writeFileSync, mkdirSync} = require('node:fs');
const ids = process.argv.slice(1);
const merged = [];
for (const id of ids) {
  try { merged.push(...JSON.parse(readFileSync('evals/results/fastgate/' + id + '/results.json', 'utf8')).results); }
  catch (e) { console.error('missing', id); }
}
merged.sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
mkdirSync('evals/results/fastgate-merged', {recursive: true});
writeFileSync('evals/results/fastgate-merged/results.json', JSON.stringify({mode: 'real', trials: 1, generatedAt: new Date().toISOString(), results: merged}, null, 2));
console.log('merged', merged.length);
" $TASKS >> "$OUT/progress.log" 2>&1
echo "=== HARNESS GATE COMPLETE $(date +%H:%M)" >> "$OUT/progress.log"
