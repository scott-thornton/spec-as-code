# Evaluation harness

Controlled comparison of two workflows on the same tasks (project plan §65–§68):

- **Control (Markdown-plan baseline)**: the model receives the task, the
  repository and Markdown planning instructions; it writes `PLAN.md`, then
  implements. No write scope, no independent verification — completion is
  whatever the agent claims.
- **Treatment (spc workflow)**: the same task flows through SpecIR → validated
  plan → bounded execution in an isolated worktree → verification → evidence.

Metrics come from **withheld ground truth** (`grading/` is copied into the
result tree only at grading time): requirement completion, regressions
introduced, forbidden modifications, false completion declarations, patch size,
model calls, replans, follow-ups raised.

## Layout

```
evals/
  runner/          @spc/evals — harness (task loading, arms, grading, report)
  tasks/<cat>/<id> repo/ (what the agent sees) · grading/ (withheld) ·
                   task.yaml · control-script.yaml · treatment-script.yaml
  tools/           committed generator for the 30 task definitions
  baselines/       committed scripted-mode reports (clearly labeled)
  results/         runtime output (gitignored)
```

30 tasks across 10 categories (feature-addition, bug-fix, refactoring,
api-change, schema-change, dependency-integration, security-fix, test-only,
configuration-change, multi-package), including three planner traps from §62:
preserve-old-API, two-edits-one-file serialization, and an under-specified
requirement that must become a blocking follow-up rather than a hallucination.

## Running

```bash
pnpm build
node evals/runner/dist/main.js --tasks evals/tasks --out evals/results/latest
# single category, several trials:
node evals/runner/dist/main.js --category bug-fix --trials 3 --out /tmp/bugfix
```

## Scripted mode vs real mode — read this before citing numbers

The default mode uses the **fake scripted provider** for both arms. The
per-task scripts encode deterministic re-enactments of known baseline failure
modes (overwriting a co-edited file, breaking an old API while "modernizing",
touching forbidden paths during test-only work, declaring done early, …) and
competent treatment behaviour. Scripted results validate **harness mechanics**
— metrics computation, grading, drift and false-completion detection — and
illustrate the failure modes the thesis predicts. They are **not evidence
about real models**; the numbers are baked into the scripts by construction.

Real experiments:

```bash
OPENAI_API_KEY=… node evals/runner/dist/main.js \
  --provider openai --model gpt-4.1 --trials 3 --out evals/results/real-$(date +%Y%m%d)
```

In real mode both arms use the same live model; the treatment arm runs the
actual spc runtime (planner → validated plan → bounded executor → independent
verifier), the control arm runs the one-shot Markdown-plan flow. Acceptance
thresholds are deliberately **not** hardcoded anywhere: per §68 they are set
only after real-mode variance stabilizes across repeated trials.

## Harness tests

`pnpm --filter @spc/evals test` covers task validation, a self-contained
end-to-end benchmark (false-completion detection, grading from withheld
tests), and a full category run including the under-specified-requirement trap
(treatment blocks with a follow-up; control ships a hallucination).
