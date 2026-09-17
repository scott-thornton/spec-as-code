# ADR-0003: Stable property identity

Date: 2026-09-17
Status: accepted

## Context

Requirements trace from spec to plan tasks to evidence to satisfaction state.
If identity is positional, moving a requirement in a document breaks every
reference.

## Decision

Property ids (requirements and constraints share one id space) are stable,
immutable, pattern-enforced (`^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$`, e.g.
`AUTH-001`, `AUTH-C01`), unique across the spec, and independent of array
position. Acceptance criterion ids share the pattern and spec-wide uniqueness.
Tasks use `T###`. Runtime ids (runs, evidence, follow-ups, observations) are
assigned sequentially per run (`EV-0001`, `F-001`, `OBS-001`) or generated.

## Consequences

- Rename or renumber of an id is a semantic change (digest changes), which is
  the correct failure mode.
- Cross-references (task `satisfies`/`verifies`, evidence `propertyRefs`) stay
  valid under document edits.

## Alternatives considered

- UUIDs per requirement: collision-proof but unreadable in every human surface.
