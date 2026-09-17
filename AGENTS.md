# AGENTS.md

Working conventions for coding agents (and humans) contributing to this
repository. The bundled skill at `.agents/skills/spc/SKILL.md` is for
*using* spc as a tool in other repositories; this file is for *developing*
spc itself.

## Commands

```bash
pnpm install --frozen-lockfile   # workspace install
pnpm build                       # build all packages (topological)
pnpm typecheck                   # strict tsc across the workspace
pnpm test                        # full deterministic suite (no network)
pnpm --filter @spc/core test     # one package
node packages/cli/dist/main.js   # the CLI (alias it as `spc`)
```

Always `pnpm build` before running the CLI or cross-package tests: tests
import sibling packages from their built `dist/`.

## Repository map

- `packages/schema` - Zod schemas and inferred types. Depends only on zod.
  No fs, Git, LLM or runtime imports, ever.
- `packages/core` - deterministic middle: canonical JSON, digests,
  diagnostics, spec compiler (including import graphs), plan validation,
  amendment application. Pure; file contents are injected, never read.
- `packages/repo` - Git adapter, bounded observation, worktrees, the fs
  spec loader.
- `packages/llm` + `llm-fake` / `llm-openai` / `llm-anthropic` /
  `llm-harness` - provider abstraction and adapters.
- `packages/planner`, `executor`, `verifier`, `renderer` - the pipeline
  stages.
- `packages/runtime` - runs, events, state projection, apply/resume
  orchestration, follow-ups. Owns all lifecycle state.
- `packages/cli` - composition root; the only place allowed to set exit
  codes.
- `evals/` - benchmark harness, 30-task corpus, committed baselines.
- `docs/usage/` - user guides; `docs/adr/` - decision records.
- `fixtures/`, `examples/` - runnable demos (deterministic, no network).

## Hard rules

- Determinism: unit and CI tests never touch the network or a live model.
  Use the fake or harness providers.
- TypeScript strict mode; ESM everywhere; relative imports need the `.js`
  suffix.
- `process.exit` only in `packages/cli` entrypoints.
- Never persist secret values into specs, plans, prompts, events, evidence
  or docs. Names and presence checks only.
- No em dashes in documentation or CLI output; use "-".
- Append-only records (`.spc/runs/**`, answered harness requests) are never
  hand-edited or deleted.
- Every material design decision gets an ADR in `docs/adr/` with context,
  decision, consequences, alternatives.

## Conventions

- Work in dependency order (schema -> core -> repo/llm -> stages ->
  runtime -> cli) and keep every commit green: build, typecheck, test.
- New deterministic behavior gets unit tests first; integration coverage
  lives in `packages/cli` (fixture-driven) and `evals`.
- Error codes are stable public surface: `SPC*` for compiler/validator
  diagnostics, named codes for runtime errors; document new ones in
  `docs/usage/diagnostics.md`.
- The repository dogfoods: `specs/self-hosting.yaml` states the tool's own
  requirements and CI runs `spc verify --format github` on every PR. Keep
  it green.
- Commit messages: `feat|fix|docs|chore: summary` in plain words.

## Dogfooding note

For changes to this repository itself, prefer the normal engineering flow
(tests first, small commits). Running the spc loop on spc is supported and
encouraged for feature-scale work: author a spec under `specs/`, plan,
apply, and let CI verify - but never bypass the hard rules above by editing
run records to make status look better.
