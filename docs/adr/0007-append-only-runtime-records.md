# ADR-0007: Append-only runtime records

Date: 2026-09-17
Status: accepted

## Context

Runs must be debuggable and replayable; a corrupted `state.json` must never
destroy progress; agents must not be able to erase inconvenient history.

## Decision

`events.jsonl`, `evidence.jsonl` and `observations.jsonl` are append-only.
`state.json` is a materialized projection over events and can be rebuilt at
any time (`projectState`). `followups.json` is a small persisted map that is
also reconstructible from events. Interrupted runs resume by replaying events:
a task stuck in `running` is retried on the next attempt counter, and no
completed task is ever re-executed.

## Consequences

- Crash recovery is structural, not best-effort.
- Every run answers: why did this task exist, what did the agent see, what
  changed, why is this requirement believed satisfied.

## Alternatives considered

- SQLite state store: rejected for V0 — files + git are an advantage locally.
