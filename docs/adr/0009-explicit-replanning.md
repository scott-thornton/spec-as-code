# ADR-0009: Explicit replanning

Date: 2026-09-17
Status: accepted

## Context

Agents discover that plans are wrong (files live elsewhere, assumptions
fail). Silent improvisation is the failure mode of plan-driven agents.

## Decision

Discoveries become `Observation` records (typed, confidence-tagged, with
`invalidates` references). A task that cannot proceed returns
`needs_replan`; the runtime suspends the affected graph, invokes a replanner
that returns a `PlanAmendment` (addTask / removeTask / replaceTask /
addDependency / changeTarget), applies it through a deterministic validator
(executed tasks are untouchable; history preserved), re-validates the whole
amended plan (coverage, cycles, write conflicts, digests), persists the
previous plan version plus the amendment in the run directory, and resumes.
Replan budget (`execution.maxReplans`) is enforced; exhaustion fails visibly
with a blocking follow-up. `replaceTask` with a new id repoints dependents.

## Consequences

- Every deviation from the original plan is visible, validated and reversible.
- The planner's wrong assumption remains inspectable in `plan-v1.json`.

## Alternatives considered

- Let executors edit any file they deem relevant: unbounded, unauditable.
