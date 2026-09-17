# Fast adversarial gate - 2026-09-17

12 adversarially selected tasks (the three planner traps, the three
forbidden-path test-only tasks, the three multi-package tasks, plus
api-deprecate-field, api-version-header, sec-remove-eval), both arms, one
paired trial. Two models, same machinery:

## GLM-5.3 (full tier) via the harness provider

The answering model was a coding agent working in this repository through
the harness provider (request/response files; 62 answers archived in
`fast-adversarial-2026-09-17-answered/`). Caveat that matters: the answering
agent had authored the corpus, so it is a saturated model - this run
measures machinery friction, not capability.

| Metric | Control (plain) | spc (structured) |
| --- | --- | --- |
| Completion | 12/12 | 12/12 |
| False done | 0 | 0 |
| Regressions / forbidden | 0 / 0 | 0 / 0 |
| Replans / blocked runs | - | 0 / 0 |
| Model calls | 24 | 25 |

**Result: zero friction.** The structured workflow let a competent agent
through unchanged - no replans, no blocked runs, no completion cost, and
the single mandated follow-up (feat-log-levels spec clarification) flowed
through on its recommended default. This is the machinery answer: the
blocked-run tax seen on flash is model caution, not structural friction.

## glm-5.3-flash (API), same 12 tasks, extracted from the three full trials

| Trial | n (ok) | Control | spc | spc blocked tasks |
| --- | --- | --- | --- | --- |
| 1 | 11 | 100% | 86% | api-version-header, feat-log-levels, test-edge-cases |
| 2 | 8 | 4 errored (rate limits) | 100% | 88% | api-version-header, feat-log-levels |
| 3 | 9 | 3 errored (rate limits) | 100% | 78% | api-version-header, feat-log-levels, sec-remove-eval |

Zero false-done, zero regressions, zero forbidden changes on either arm in
every trial. Every spc loss is a `blocked` run, never a bad edit.

**Reading (updated post-fix):** api-version-header blocked in 3/3 flash
trials. Root cause turned out to be two bugs stacked: the executor
re-blocking on clarifications the demotion policy had already demoted
(fixed in the runtime, ADR-0013 addendum), and the task spec omitting the
header value the grading expected (fixed in the corpus). After both fixes:
3/3 succeeded on glm-5.3-flash, completion 1.0, zero follow-ups raised.
feat-log-levels blocking is correct behavior (it is the under-specified
trap). The remainder is scattered caution. Control completing 100% here
means flash handles these small adversarial tasks fine when unstructured -
the caution tax buys nothing at this task size, consistent with the
full-baseline conclusion.

## Combined verdict

- Machinery: validated - a competent agent passes through the structured
  workflow with zero friction and slightly smaller patches.
- Model-tier sensitivity confirmed: the completion gap is flash-tier
  caution expressed through blocking; it does not reproduce at full tier.
- Bad outcomes (false done, regressions, forbidden changes): zero on both
  arms, both tiers - at this task size the baseline has no room to fail,
  so the safety-vs-speed trade cannot be settled by this corpus. Real
  repositories remain the open question.
