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

## Alternatives considered

- Auto-ansering follow-ups with a model call: reintroduces hallucination
  risk the follow-up exists to prevent.
- Planner prompt tuning alone: measured to be insufficient (the baseline
  already carried the hardened prompt).
