# ADR-0002: Canonical IR vs authoring YAML

Date: 2026-09-17
Status: accepted

## Context

Humans author specs; the system must hash, compare and validate them. YAML is
ergonomic but unordered and permissive; digests require canonical forms.

## Decision

YAML is an authoring interface only. Compilation (parse -> schema -> semantic
validation -> normalization) produces an immutable `SpecIR` (normalized spec,
flat desired-property list, digest). Canonical JSON sorts object keys
recursively, preserves array order, omits undefined properties, and rejects
cycles/NaN/Infinity/bigint/functions/symbols/Dates. Digests are
`sha256:<hex>` over canonical JSON. Compiler normalization additionally sorts
and de-duplicates documented set-like arrays (`dependsOn`, `satisfies`,
`verifies`, target globs) while never reordering requirements, constraints,
acceptance criteria, tasks or `outOfScope`. Generated Markdown is an output
view only and is never parsed back.

## Consequences

- Identical logical content yields identical digests regardless of key order
  or formatting; plan/spec staleness checks are exact.
- Authoring mistakes (duplicate keys, unknown fields) surface as compiler
  diagnostics with source locations.

## Alternatives considered

- JSON authoring: canonical by nature, rejected as too hostile for humans.
- TOML: fine for config, awkward for nested lists of criteria.
