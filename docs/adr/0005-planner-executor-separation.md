# ADR-0005: Planner/executor separation

Date: 2026-09-17
Status: accepted

## Context

When one agent both invents the plan and executes it, plans become
retrospective explanations of whatever the agent did.

## Decision

Planner and executor are separate provider invocations with separate prompts
and contracts. The planner receives SpecIR + repository snapshot + excerpts and
returns structured `{plan, observations, assumptions, followups}`; it cannot
write files. The executor receives exactly one task with explicit read/write
scopes and returns structured changes/observations/follow-ups; it cannot
produce canonical spec/plan/lifecycle state. All model output passes
deterministic validation (schema, DAG, coverage, write-conflict, digest
checks) with at most two structured repair attempts before failing visibly.

## Consequences

- Plans are auditable artifacts validated before any code runs.
- Executor drift is mechanically detectable (git delta vs declared write set).

## Alternatives considered

- Single planning-executing agent with a long context: cheaper, but exactly
  the workflow this project exists to replace.
