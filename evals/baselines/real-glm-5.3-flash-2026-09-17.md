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

---

# Post-fix full harness rerun (2026-09-18)

Harness-mode rerun of all 30 tasks against the **fixed** code (clarification
demotion per ADR-0013 addendum + api-version-header corpus fix): the runner
emits every model request as a file and the answering agent answers it in
place — no API calls. **The answering agent is the same coding agent (running
GLM-5.3-Flash) for BOTH arms**, under equal-effort rules: baseline arm
answered as a plain competent engineer from the request alone, spc arm
answered per each role's contract (planner / executor / replanner). Grading
stays withheld (never arm self-reports). 1 trial, 2026-09-18, run time ~73
minutes, 146 requests answered.

Because one agent fills both arms, this run isolates workflow gating from
model variance and endpoint instability — but it is **not** directly
comparable to the API trials above as a model-quality measurement; treat it
as a plumbing/gating regression test of the fixed tool.

## Results

| Metric | spc | Baseline (Markdown arm) |
| --- | --- | --- |
| Completion (requirements satisfied) | **spc 100%** (30/30 tasks, all properties) | **baseline 100%** (30/30) |
| False-done declarations | 0 | 0 |
| Regressions introduced | 0 | 0 |
| Forbidden modifications | 0 | 0 |
| Blocked runs | **0 / 30** | n/a (baseline arm has no blocking path) |
| Replans / follow-ups raised | 0 replans, 1 follow-up | n/a |

Raw data: `evals/results/full-harness-merged/results.json`
(merged from `evals/results/full-harness/<task>/results.json`),
aggregate via `node evals/tools/aggregate-real.mjs evals/results/full-harness-merged`.

## Tasks spc lost or blocked

None. Every task finished `succeeded` on the spc side and 100% completion on
the baseline side. No blocked runs anywhere, so there is no residue to
diagnose.

On `feat-log-levels` (the designed under-specified trap): the spc planner
**did** raise the blocking `spec_clarification` follow-up — the trap still
works as designed at the planning layer (`followupsRaised = 1` is visible in
the result row). Under the fixed code the run's clarification policy demotes
it to non-blocking, the executor proceeds with the recommendedDefault
(conventional debug/info/warn/error levels, default info, recorded as an
observation), and the task completes. That is exactly the intended post-fix
behaviour: the under-specification is *surfaced and recorded*, not silently
invented and not run-gating.

## Comparison to the pre-fix API record

| Metric | Pre-fix API re-measure | This harness rerun |
| --- | --- | --- |
| Requirement completion | spc 87%, baseline 93% (spc −6 pp) | spc 100%, baseline 100% (parity) |
| spc blocked runs | 5 / 30 | 0 / 30 |
| False completions | spc 2, baseline 2 | 0 / 0 |
| Regressions / forbidden | 0 / 0 | 0 / 0 |
| Answering model | glm-5.3-flash via API | same model, harness mode (agent-answered) |

What changed, plainly:

1. **The blocked-run residue is gone.** The 5 API-side blocks (planner
   over-caution + `feat-log-levels` by design) disappear under the fixed
   clarification policy: clarifications are recorded, not run-gating.
2. **Completion reached parity at 100% for both arms.** The remaining −6 pp
   API-side gap did not reproduce here; with the same agent answering both
   arms and endpoint errors removed from the equation, the workflow adds no
   completion loss on this corpus.
3. **Caveat:** parity at 100% on n=1 harness trial says the fixed *gating* is
   clean, not that the model got stronger. The §94 question "does spc beat a
   plain engineer arm" needs the API rerun with independent models per arm;
   this run only certifies that the failure modes measured above no longer
   fire.
