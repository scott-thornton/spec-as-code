# Architecture

`spc` treats software requirements as declarative desired state. The core
loop: **Spec → Plan → Execute → Verify → Status**, with evidence — never agent
self-reporting — establishing requirement satisfaction.

```
Desired Spec ──► compile (YAML→SpecIR+digest) ──► validated Plan ──► bounded
Execution (worktree) ──► Evidence collection ──► Verification ──► Observed
State ──► status/diff ──► next reconciliation
```

## Packages

| Package | Responsibility | May depend on |
| --- | --- | --- |
| `@spc/schema` | Zod schemas + inferred types for every persisted structure | zod only |
| `@spc/core` | canonical JSON, SHA-256 digests, diagnostics, graph/glob, spec compiler, plan validation, amendment application | schema |
| `@spc/repo` | git adapter, bounded observation, snapshots, worktrees | schema, core |
| `@spc/llm` | provider-neutral structured generation, usage accounting | schema, core |
| `@spc/llm-fake` | deterministic scripted provider (tests/fixtures) | llm, core |
| `@spc/llm-openai` | fetch-based OpenAI-compatible adapter | llm |
| `@spc/planner` | planner + replanner with bounded repair loops | schema, core, llm, repo |
| `@spc/executor` | sequential DAG scheduler, task execution, write enforcement, command policy | schema, core, llm, repo |
| `@spc/verifier` | criterion dispatchers, evidence-based satisfaction evaluator | schema, core, llm, executor |
| `@spc/renderer` | one-directional Markdown/text views | schema, core |
| `@spc/runtime` | runs, events, projections, stores, apply/resume orchestration, follow-ups | everything above |
| `@spc/cli` | composition root, command surface | everything |

## Repository layout when operating on a project

```
specs/*.yaml            human-authored desired state (committed)
.spc/config.yaml        provider + policy configuration (committed)
.spc/plans/<id>.json    generated plans + approval markers (ignored)
.spc/worktrees/<run>/   execution isolation (ignored)
.spc/runs/<run>/        metadata, state.json, events/evidence/observations
                        (JSONL, append-only), followups.json, summary.md,
                        amendments/, plan-vN.json history
```

## Invariants

1. **Identity** — property ids are stable and pattern-enforced; array position
   is presentation only.
2. **Determinism** — digests over canonical JSON; schema/core are pure; unit
   tests never touch a live model.
3. **Separation** — planner/executor/verifier are distinct provider roles;
   the runtime owns all lifecycle state.
4. **Evidence** — satisfaction is derived from append-only evidence with
   explicit provenance (L1 deterministic … L4 human); contradictory evidence
   is retained forever.
5. **Bounded execution** — per-task write scopes checked against the *actual*
   git delta; commands classified and policy-gated; one worktree per run;
   budgets on model calls, replans, retries, timeouts.
6. **Explicit replanning** — observations invalidate tasks; amendments are
   validated and history-preserving; budgets fail visibly.
7. **Structured uncertainty** — follow-ups are data, resolvable through the
   CLI, and feed back as human evidence.
8. **Recoverability** — state is a projection over events; interrupted runs
   resume by replay.

See `docs/adr/` for decision records.
