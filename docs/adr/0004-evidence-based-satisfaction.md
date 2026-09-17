# ADR-0004: Requirement status comes from evidence

Date: 2026-09-17
Status: accepted

## Context

An agent saying "done" is not evidence that a requirement is satisfied.
Satisfaction must be derivable, auditable and honest about uncertainty.

## Decision

Requirement state is derived exclusively from immutable, append-only evidence
records (`Evidence`: kind, outcome supports/contradicts/inconclusive, producer
provenance, repository revision, digest). Evaluation rules, per acceptance
criterion (latest evidence wins): any contradiction -> `unsatisfied`; any
inconclusive (incl. outstanding human verification) -> `indeterminate`; all
passing -> `satisfied`. Agent-only support is `indeterminate` unless
`verification.allowAgentOnlyMustRequirements` is explicitly enabled (and is
then flagged `weakEvidence`). States are the qualitative set
`unknown/in_progress/satisfied/unsatisfied/indeterminate/waived` - never
percentages. Human waivers come only from resolved follow-ups. Evidence trust
levels (1 deterministic command/test, 2 static file/diff, 3 agent, 4 human)
stay visible in every rendering. Contradictory evidence is never deleted.

## Consequences

- `spc status` answers "why does the system believe this" with provenance.
- Run success requires must-properties satisfied/waived, not tasks completed.

## Alternatives considered

- Weighted scores: rejected - false precision.
- Executor self-attestation: rejected - the core anti-pattern.
