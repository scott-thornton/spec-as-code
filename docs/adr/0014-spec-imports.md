# ADR-0014: Spec composition via imports

Date: 2026-09-17
Status: accepted

## Context

§79 defers spec composition ("avoid before single-spec semantics are stable")
until org-scale shared invariants become a real need. The single-spec path has
since soaked: compiler, plan validation, execution, verification, and one
measured iteration on blocking semantics. With publication intended, the
shared-invariants case (`imports: [./security.yaml]`) is the first piece of
§79 to earn its keep.

## Decision

`imports:` on a spec composes the referenced files into one graph at compile
time, with these rules:

- **Entry identity.** The entry file's metadata/goal define the composed
  spec; imported files are libraries whose own metadata is ignored (but
  validated).
- **IDs are never rewritten.** Traceability with existing evidence requires
  stable identity, so cross-file ID collisions are hard errors (SPC1008)
  naming both files - not namespacing, not renaming.
- **Cross-file references.** `dependsOn` may reference imported properties;
  resolution and cycle detection run over the composed property set, with
  per-file source locations rebased onto merged indices so diagnostics point
  at the right file.
- **Digest covers the composed graph.** The digest is computed over the
  composed normalized spec, so editing any file in the graph changes it -
  plan staleness (SPC2009) works across imports. Composing is
  digest-identical to authoring the merged file by hand.
- **Cycles and missing files** are rejected (SPC1006/SPC1007) with the cycle
  chain or path. Diamond imports are fine (each file loads once).
- **outOfScope** is the deduplicated union; requirements/constraints follow
  entry-first, declaration-order, transitive traversal - deterministic.

Core stays pure: the graph compiler takes an injected `read` (filesystem
loading lives in `@spc/repo`), so `@spc/schema`/`@spc/core` still have no fs
dependency.

## Consequences

- Org-wide invariants live in one file and compose into feature specs;
  planners and verifiers see one flat property set (no downstream changes
  were needed).
- A bad shared spec fails every feature spec that imports it - propagation
  is the feature, so SPC1008's strictness is the safety catch.

## Alternatives considered

- ID namespacing (`file#ID`): breaks evidence traceability and human habit;
  prefix conventions (SEC-001, AUTH-001) already provide de-facto namespacing.
- Merge at plan time instead of compile time: pushes ambiguity into the
  planner and weakens the digest contract.
