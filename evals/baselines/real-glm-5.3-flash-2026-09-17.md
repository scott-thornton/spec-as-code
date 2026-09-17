# Real-model benchmark - glm-5.3-flash (the §66–§68 gate)

- Date: 2026-09-17 · Model: glm-5.3-flash via the Anthropic-compatible coding endpoint (api.z.ai)
- Arms: Markdown-plan baseline (plan → implement, self-reported) vs the spc workflow (SpecIR → validated plan → bounded worktree execution → independent verification), same model, same bounded repo view per arm, no tool access
- 3 trials × 30 tasks; grading from withheld tests (never arm self-reports)
- Endpoint rate limiting cost some tasks (t1: 2, t2: 11, t3: 5 errored rows excluded from aggregates); coverage is uneven but the per-trial picture is consistent

## What code this measures

All numbers in this document describe the tool **as it existed when the runs
executed** (2026-09-17, pre-fix). The executor-side clarification-demotion
fix (ADR-0013 addendum) and the api-version-header corpus fix postdate these
trials: that task now completes 3/3 on the same model where it blocked 3/3
here. The full-trial aggregate has not been re-run with the fixed code, so
treat these figures as the pre-fix record, not the current tool's expected
performance.

## Verdict

**The thesis is not validated on this model and task size.** Across 72 scored
task-pairs the spc workflow completed materially FEWER ground-truth
requirements than the Markdown-plan baseline (spc 77.3% ± 2.1%, baseline 98.7% ± 2.3%),
did not reduce false completion declarations (0.67 vs 0.33 - both near zero),
and used ~3× the tokens. Neither arm introduced forbidden modifications;
regressions were 0 (baseline) vs 0.33 (spc). Per §68's own gates this result
says: do **not** proceed to parallel execution or control planes; per §94,
iterate the abstraction rather than adding infrastructure.

## Why the treatment lost (failure analysis)

The completion gap is dominated by **blocked runs**, not bad edits: of the
unsatisfied treatment outcomes, most were runs the planner halted with a
blocking `spec_clarification` follow-up on tasks that were adequately
specified (7 of 8 blocked tasks in trial 1). One blocked task
(`feat-log-levels`) is the *designed* under-specified trap - blocking there is
correct behaviour. `api-version-header` blocked in all three trials
(systematic, worth a planner-contract fix). When the workflow did execute, its
edits were clean: zero forbidden modifications anywhere, and only one
regression (sec-redact-token, trial 1). The safety machinery works; on a
flash-tier model it is simply too trigger-happy, trading completion for
caution - while the baseline one-shot flow was already good enough on these
small repositories to produce zero false-done claims.

The plausible fixes this evidence points at (future work, explicitly gated on
a re-run of this benchmark): an auto-resolution policy for low-risk
clarification follow-ups (§31 medium-risk tier), planner prompt/repair tuning
for verification-path planning, and re-testing on a non-flash model where the
baseline is expected to be sloppier.

# Real-model benchmark - aggregate over trials

- Trials: 3 (evals/results/real-glm53f-t1, evals/results/real-glm53f-t2, evals/results/real-glm53f-t3)
- Tasks per trial: 30
- Mode: real

## Per-trial headline

| Trial | Tasks (ok) | Ctrl completion | spc completion | Ctrl false-done | spc false-done | Ctrl regr | spc regr | Ctrl forb | spc forb | Ctrl tok in/out | spc tok in/out |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 28 | 100% | 75% | 0 | 0 | 0 | 1 | 0 | 0 | 36,443/68,380 | 108,832/181,166 |
| 2 | 19 | 100% | 79% | 0 | 1 | 0 | 0 | 0 | 0 | 25,343/58,049 | 84,223/124,259 |
| 3 | 25 | 96% | 78% | 1 | 1 | 0 | 0 | 0 | 0 | 32,793/72,125 | 89,488/155,357 |

## Variance across trials (mean ± sd)

| Metric | Control | spc workflow |
| --- | --- | --- |
| Completion rate | 0.987 ± 0.023 | 0.773 ± 0.021 |
| False completions | 0.333 ± 0.577 | 0.667 ± 0.577 |
| Regressions | 0 ± 0 | 0.333 ± 0.577 |
| Forbidden modifications | 0 ± 0 | 0 ± 0 |

## Per-task stability (completion per trial)

| Task | Ctrl | spc | spc status |
| --- | --- | --- | --- |
| api-deprecate-field | 100/100/100 | 100/100/100 | succeeded/succeeded/succeeded |
| api-optional-param | 100/100/100 | 100/100/100 | succeeded/succeeded/succeeded |
| api-version-header | 100/100/100 | 0/0/0 | blocked/blocked/blocked |
| fix-date-format | 100/100/100 | 100/100/100 | succeeded/succeeded/succeeded |
| fix-null-user | 100/100/100 | 100/100/100 | succeeded/succeeded/succeeded |
| fix-off-by-one | 100/100/100 | 100/100/100 | succeeded/succeeded/succeeded |
| config-env-port | 100/100/0 | 100/0/0 | succeeded/blocked/blocked |
| config-gitignore-dist | 100/ERR/100 | 100/ERR/100 | succeeded/error/succeeded |
| config-timeout | 100/100/100 | 0/0/0 | blocked/blocked/blocked |
| dep-intl-currency | 100/100/100 | 0/100/50 | blocked/succeeded/succeeded |
| dep-node-crypto | 100/100/100 | 100/100/100 | succeeded/succeeded/succeeded |
| dep-url-searchparams | 100/100/100 | 100/100/100 | succeeded/succeeded/succeeded |
| feat-greeting-name | 100/ERR/100 | 50/ERR/100 | blocked/error/succeeded |
| feat-log-levels | 100/100/100 | 100/100/100 | blocked/blocked/blocked |
| feat-math-max | 100/100/100 | 100/100/100 | succeeded/succeeded/succeeded |
| mono-cross-feature | 100/100/100 | 100/100/100 | succeeded/succeeded/succeeded |
| mono-shared-const | 100/100/100 | 100/100/100 | succeeded/succeeded/succeeded |
| mono-version-bump | 100/100/ERR | 100/100/ERR | succeeded/succeeded/error |
| refactor-extract-const | 100/ERR/100 | 100/ERR/100 | succeeded/error/succeeded |
| refactor-rename-internal | 100/ERR/ERR | 100/ERR/ERR | succeeded/error/error |
| refactor-split-module | 100/ERR/ERR | 100/ERR/ERR | succeeded/error/error |
| schema-add-field | 100/ERR/ERR | 100/ERR/ERR | succeeded/error/error |
| schema-narrow-type | 100/ERR/100 | 0/ERR/100 | blocked/error/succeeded |
| schema-rename-field | 100/100/100 | 0/0/0 | blocked/succeeded/blocked |
| sec-path-traversal | ERR/ERR/100 | ERR/ERR/100 | error/error/succeeded |
| sec-redact-token | 100/100/100 | 0/100/100 | failed/succeeded/succeeded |
| sec-remove-eval | ERR/100/100 | ERR/100/0 | error/succeeded/blocked |
| test-add-coverage | 100/ERR/ERR | 100/ERR/ERR | succeeded/error/error |
| test-edge-cases | 100/ERR/100 | 50/ERR/100 | blocked/error/succeeded |
| test-fix-expectation | 100/ERR/100 | 100/ERR/100 | succeeded/error/succeeded |

## Proposed §68 acceptance thresholds (derived from observed variance)

- Observed completion delta: spc finished 21.4 points behind the baseline (pooled sd 2.2 pp).
- With n=3 trials this is a descriptive result, not a significance test; treat thresholds below as reviewable engineering gates, and re-derive them as n grows.

Continue investing in the workflow only while ALL hold:
1. spc completion ≥ control completion + 5 pp (delta above noise).
2. spc false completions ≤ 1 (never worse than baseline).
3. spc regressions + forbidden modifications ≤ control on every trial.
4. spc token overhead ≤ 3× control (observed: 2.54×).



---

# Addendum (same day): §94 iteration - re-measured

The baseline above pointed at over-cautious blocking follow-ups as the
dominant loss. We implemented the indicated fix -
`execution.proceedOnClarificationFollowups` demotes blocking
`spec_clarification` follow-ups to non-blocking (recorded, visible, but not
run-gating) - and re-ran the full benchmark under identical conditions
(glm-5.3-flash, 30 tasks, withheld grading; 1 trial).

| Metric | Baseline run (no demotion policy) | Re-measure (demotion policy on) |
| --- | --- | --- |
| Requirement completion | spc 77.3%, Markdown baseline 98.7% - spc 21.4 points behind | spc 87%, Markdown baseline 93% - spc 6 points behind |
| spc blocked runs | 8 / 27 scored | 5 / 30 |
| False completion declarations | spc 0.67 avg (baseline 0.33) | spc 2, baseline 2 (parity) |
| Regressions / forbidden changes (both arms) | spc 0.33 / 0 | 0 / 0 |
| spc token overhead vs baseline | ~2.5x to 3x | 2.95x |

Interpretation: one targeted abstraction change recovered roughly two-thirds
of the completion gap without giving up the safety properties (zero
forbidden modifications, no false-completion advantage for the baseline).
The remaining blocked tasks include `feat-log-levels` (the *designed*
under-specified trap - correct behaviour) and a small residue of planner
over-caution that the next iteration (planner verification-path tuning, and
re-testing on a non-flash model) should target. This is the §68/§94 loop
functioning as intended: measure → iterate → re-measure.
