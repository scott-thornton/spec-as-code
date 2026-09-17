# ADR-0013: Demotion of blocking spec-clarification follow-ups

Date: 2026-09-17
Status: accepted

## Context

The real-model benchmark (glm-5.3-flash) showed the workflow losing ~21 pp
of requirement completion almost entirely through blocked runs: the planner
raised blocking `spec_clarification` follow-ups on tasks that were, in
retrospect, adequately specified. The safety valve was correct machinery
firing at the wrong threshold.

## Decision

`execution.proceedOnClarificationFollowups` (default false) demotes blocking
`spec_clarification` drafts to non-blocking at apply time: the follow-up is
still created, recorded in events (`FOLLOWUP_CREATED` with `demoted: true`)
and visible after the run, but the run proceeds with the planned transition.
Other blocking types (approval, missing_secret, missing_environment,
spec_change) always gate. This instantiates §31's medium-risk tier:
continue when no spec or public-API change is implied by proceeding.

## Consequences

- Re-measured on the same benchmark: completion gap narrowed from −21.4 pp
  to −6 pp, blocked runs halved, with zero forbidden modifications and
  false-completion parity maintained (see the baseline addendum).
- The default stays false: high-stakes repositories keep the strict gate;
  the benchmark/evals configuration opts in explicitly.

## Addendum (same day): executor-side demotion

The fast adversarial gate exposed the second half of the problem: the
planner's clarification was demoted correctly, but the EXECUTOR never
learned that - it independently rediscovered the same ambiguity, returned
`blocked`, and drafted its own blocking clarification, which the
planner-only demotion did not cover (the api-version-header 3-for-3 flash
block). Two fixes, both runtime-enforced:

1. Executor context now carries the open clarifications (with recommended
   defaults) and the policy statement whenever the demotion policy is on.
2. Belt-and-braces: a task that blocks with ONLY clarification drafts under
   the policy has those drafts demoted at creation and is failed once with
   `CLARIFICATION_PROCEED` guidance, so the existing retry machinery
   re-executes it with proceed-on-default instructions injected. Strict mode
   (policy off) and non-clarification blocks (missing secrets and friends)
   are never demoted.

Verification: the diagnosed task now completes 3/3 on glm-5.3-flash with
zero follow-ups raised (the spec carrying its value removed the ambiguity;
the executor machinery holds). A second, corpus-side bug surfaced during
verification: the task spec omitted the header value the grading expected,
so a defensible executor default ("1.0.0") failed hidden grading while the
run honestly reported satisfied - fixed in the corpus, and exactly the kind
of false-satisfaction the evaluator design is meant to surface.

## Alternatives considered

- Auto-ansering follow-ups with a model call: reintroduces hallucination
  risk the follow-up exists to prevent.
- Planner prompt tuning alone: measured to be insufficient (the baseline
  already carried the hardened prompt).
