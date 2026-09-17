# ADR-0001: Core architecture

Date: 2026-09-17
Status: accepted

## Context

The tool must treat requirements as declarative desired state, produce validated
plans, execute bounded tasks, and derive satisfaction from evidence. Agent
self-reporting ("done") is not evidence. The system must remain debuggable
without reading chat transcripts.

## Decision

TypeScript monorepo, ESM, Node 22+, pnpm workspaces, with strict package
boundaries:

- `@spc/schema` - persisted Zod schemas + inferred types. No fs/git/LLM deps.
- `@spc/core` - deterministic: canonical JSON, SHA-256 digests, diagnostics,
  graph/glob utilities, spec compiler, plan validation, amendment application.
- `@spc/repo` - git adapter, bounded repository observation, worktrees.
- `@spc/llm` - provider-neutral structured generation; `llm-fake` (scripted)
  and `llm-openai` (fetch-based) adapters.
- `@spc/planner` - structured planning with bounded validation-repair loops.
- `@spc/executor` - sequential DAG scheduler, bounded task execution,
  write-scope enforcement, categorized command runner.
- `@spc/verifier` - acceptance-criterion dispatchers, evidence-based
  satisfaction evaluator.
- `@spc/runtime` - runs, append-only events, state projection, apply
  orchestration, replanning, recovery, follow-up resolution.
- `@spc/renderer` - generated Markdown/text views (one-directional).
- `@spc/cli` - composition root and command surface.

Dependency direction is one-way toward schema/core; schema depends on nothing
but zod. Intelligence sits at the edges (planner/executor/verifier providers);
state and control in the middle are deterministic.

## Consequences

- Deterministic layers are fully unit-testable without models or network.
- Provider swapping (fake/openai) does not touch core semantics.
- More packages than a single-package design, but boundaries are the product.

## Alternatives considered

- Single package: simpler setup, but loses the enforced boundary that keeps
  LLM concerns out of the deterministic core.
- Rust/Go binary: better distribution, worse schema/type iteration speed for V0.
