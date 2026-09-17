# ADR-0010: Structured follow-ups

Date: 2026-09-17
Status: accepted

## Context

Uncertainty (missing spec detail, needed approvals, human review, blocked
verification) otherwise degrades into prose inside logs and chat transcripts,
where it disappears.

## Decision

Follow-ups are first-class runtime records (`FollowUp`: type, blocking flag,
title/description, options with a recommended default, optional property and
criterion linkage, status, resolution). They are created by the planner
(spec_clarification etc., materialized at apply), by verification
(manual_verification, investigation for policy-blocked commands), and by
failure paths (replan). Blocking unresolved follow-ups gate `spc apply`
(prior runs of the same spec) and run completion. Resolution
(`spc followup resolve <id> --option <id> [--note]`) is an event; when the
follow-up carries a criterion, resolution records human evidence (confirm /
reject / waive semantics) and re-derives the property state.

## Consequences

- Human decisions become part of the run record with timestamps and outcomes.
- "The agent was blocked" turns into an actionable queue.

## Alternatives considered

- Markdown notes in the run summary: not queryable, not enforceable.
