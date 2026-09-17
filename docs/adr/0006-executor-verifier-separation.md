# ADR-0006: Executor/verifier separation

Date: 2026-09-17
Status: accepted

## Context

The same model invocation that implements something must not be the one that
decides whether the implementation is correct - implementation bias makes
self-verification systematically optimistic.

## Decision

Verification runs as independent dispatch (never the executor's invocation):
command/file criteria run deterministically in the runtime; `agent` criteria
invoke a dedicated verifier role with only the property, the instruction and
repository context (never the planning conversation); `human` criteria create
structured follow-ups and stay `indeterminate` until resolved. The verifier
never implements fixes.

## Consequences

- Satisfaction claims have provenance separate from the change author.
- Deterministic criteria short-circuit model calls entirely (cost + bias).

## Alternatives considered

- Executor-run tests as evidence: kept, but as runtime-recorded command
  evidence from acceptance criteria, not as executor claims.
