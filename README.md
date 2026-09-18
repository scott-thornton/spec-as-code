# spec-as-code

Requirements are authored as declarative YAML specs. A spec compiles to a
canonical IR whose SHA-256 digest is the specification's identity. Plans
are generated and deterministically validated before anything executes.
Coding agents execute with bounded, per-task write scopes in an isolated
Git worktree. Requirement satisfaction is established only by recorded
evidence the runtime collected itself.

> An agent saying "done" is never sufficient evidence that a requirement
> is satisfied.

## What spc is

A v0.1 vertical slice of a requirements-as-state workflow:

- **Author** requirements, constraints and acceptance criteria in YAML.
  Four criterion types carry different evidence strength: command, file,
  agent, human. Shared invariants compose via `imports:`.
- **Compile** to canonical SpecIR; the digest is the spec's identity.
  Unknown fields, ID collisions and dependency cycles are compile errors
  with file:line:column diagnostics and stable `SPC*` codes.
- **Plan** through any provider - OpenAI-compatible, Anthropic-compatible,
  a coding harness, or a deterministic fake. The plan is validated
  deterministically (must-coverage, cycles, verification paths, write
  conflicts) and repaired from diagnostics at most twice.
- **Execute** in a dedicated Git worktree, one branch per run. Write scopes
  are enforced against the actual Git diff, not agent claims. Sequential
  or parallel (disjoint write sets merge deterministically).
- **Verify** by running acceptance criteria and deriving requirement status
  from append-only evidence. Uncertainty blocks as structured follow-ups
  instead of being guessed through.

## Architecture

```
Spec (desired) ─► Plan (validated transition) ─► Execute (bounded, isolated)
      ▲                                                          │
      │                                                   Evidence (append-only)
   status/diff ◄──── Verification (independent) ◄─────────────────┘
```

Packages: `@spc/schema` (persisted schemas), `@spc/core` (compiler,
canonical hashing, validation), `@spc/repo` (Git, observation, worktrees),
`@spc/llm` (+`fake`/`openai`/`anthropic`/`harness` adapters),
`@spc/planner`, `@spc/executor`, `@spc/verifier`, `@spc/runtime`,
`@spc/renderer`, `@spc/cli`.

## Requirements

- Node.js 22+ and pnpm 9+ (not yet published to npm - use it from a clone)
- Git (execution isolation uses worktrees; nothing is merged or pushed
  automatically)
- A model provider for planning and agent execution - or none:
  `spec validate`, `verify` with command/file criteria, `status`, `diff`
  and `followups` all run without one

## Install

```bash
git clone https://github.com/scott-thornton/spec-as-code
cd spec-as-code
pnpm install --frozen-lockfile
pnpm build
alias spc='node "$PWD/packages/cli/dist/main.js"'
```

Every command below assumes that alias.

## Author a specification

```yaml
apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: greeting-api
  title: Greeting API
goal: Expose a greeting function that returns "hello".
requirements:
  - id: GREETING-001
    statement: Calling greeting returns "hello".
    priority: must
    acceptance:
      - id: GREETING-001-A
        type: command
        command: node --test "tests/*.test.mjs"
        expect:
          exitCode: 0
outOfScope:
  - multilingual greetings
```

The acceptance command is what spc itself executes and records; it is the
requirement's proof obligations, not prose.

## Validate it

```bash
spc spec validate specs/greeting.yaml
```

Prints the property count, a checklist and the digest. Recompiling a
semantically identical specification always produces the identical digest;
key order and formatting do not matter. Errors print as compiler
diagnostics with source excerpts.

## Plan

```bash
spc plan specs/greeting.yaml
```

Observes the repository (bounded snapshot: languages, manifests, tests,
likely relevant files), generates a task graph with explicit read/write
targets per task, validates it deterministically, and persists it under
`.spc/plans/`. The plan records the spec digest; change the spec and the
old plan is refused.

## Apply

```bash
spc apply
```

Preflight refuses dirty repositories and stale plans. Execution happens in
a fresh worktree on branch `spc/<specId>/<runId>`; the working tree is
never touched. Each task may only write inside its declared targets -
checked against the real Git diff, so an out-of-scope edit fails the task
(`OUT_OF_SCOPE_WRITE`) instead of shipping. The run finishes `succeeded`
only when every must requirement is satisfied or waived by recorded
evidence; a run that cannot proceed blocks on a structured follow-up
rather than improvising.

## Check status

```bash
spc status
spc diff
```

Status is requirement-oriented: per-property state with the reason and the
evidence provenance behind it (deterministic-test, static-file,
agent-review, human-review). Diff is desired versus observed. Both accept
`--format json`.

## Resolve follow-ups

```bash
spc followups
spc followup resolve F-001 --option confirm
```

Missing spec detail, approvals, manual verification and waivers are data,
not prose in logs. Criterion-linked resolutions become human evidence and
re-derive the property status immediately.

## Semantics and guarantees

- The digest covers the composed import graph: editing any imported file
  invalidates plans built against the old spec.
- Property IDs are stable identity, never rewritten; cross-file collisions
  are compile errors, not namespaces.
- Evidence is append-only. Contradictory evidence is retained forever;
  requirement status is derived from it per criterion (newest wins).
- Write scopes are enforced against the actual Git delta. Merge conflicts
  during parallel execution fail the task (`EXECUTION_CONFLICT`); nothing
  is resolved silently.
- Runs are replayable from `events.jsonl`; `state.json` is a projection.
  Interrupted runs resume (`spc apply --resume`) without re-executing
  completed work.
- Secrets are presence-checked names only; values are never read into
  specs, plans, prompts or persisted records. Command output is redacted
  before persistence.
- Commands are policy-classified (network, push, publish, destructive
  denied by default; installs and migrations approval-gated); permission
  checks live in code, never in prompts.

## Run records contract

- Commit `specs/` and `.spc/config.yaml`; `.spc/runs/`, `worktrees/` and
  `plans/` are generated state and ignored.
- Never hand-edit run records; status comes from evidence, and hand edits
  desynchronize the projection from the event log.
- The run branch is yours to review and merge; spc never merges or pushes.

## Current v0.1 limitations

Single repository, single spec per plan. Planning and agent execution need
a provider (API key, or an agent answering harness requests through
files). Agent-verified requirements are flagged and stay indeterminate
unless explicitly allowed. The benchmark corpus measures small-task
behavior; real-repository behavior is unmeasured. No npm package yet.

## Documentation

- `docs/why-spc.md` - what it gives you, what it does not, when to skip it
- `docs/usage/getting-started.md` - zero to a verified run
- `docs/usage/spec-authoring.md` - every field, criterion type and rule
- `docs/usage/cli-reference.md` - every command, flag and exit code
- `docs/usage/configuration.md` - every `.spc/config.yaml` option
- `docs/usage/workflows.md` - features, drift, invariants, parallelism, CI
- `docs/usage/agent-harnesses.md` - running spc through a coding harness
- `docs/usage/followups-and-approvals.md` - the human loop, gates, waivers
- `docs/usage/diagnostics.md` - every error and warning code
- `docs/architecture.md` and `docs/adr/` - decisions and their reasons
- `evals/README.md` - benchmark harness; results in `evals/baselines/`
- `CONTRIBUTING.md` and `AGENTS.md` - how to change this repository

## Repository development commands

```bash
pnpm install --frozen-lockfile
pnpm build            # all packages, topological
pnpm typecheck        # strict tsc across workspaces
pnpm test             # deterministic suite, no network, no live model
node packages/cli/dist/main.js verify   # the tool's own spec, in CI
```
