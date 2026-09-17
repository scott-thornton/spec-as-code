# spec-as-code (`spc`)

A local developer tool that treats software requirements as **declarative
desired state**, produces **validated execution plans**, executes them through
**bounded** coding agents, and establishes requirement satisfaction through
**collected evidence** rather than agent self-reporting.

```
Spec (desired) ─► Plan (validated transition) ─► Execute (bounded, isolated)
      ▲                                                          │
      │                                                   Evidence (append-only)
   status/diff ◄──── Verification (independent) ◄─────────────────┘
```

The critical invariant: **an agent saying "done" is never sufficient evidence
that a requirement is satisfied.**

**Status: experimental (v0.1.0).** The workflow runs end to end, and the
tool verifies its own requirements in its own CI. It guarantees: agents
execute with bounded write scopes, requirement status comes only from
recorded evidence, runs are isolated in their own worktrees and fully
replayable, and uncertainty blocks honestly instead of being guessed
through. Comparative benchmark results (one flash-tier model, small tasks)
are published unaltered in [evals/baselines](evals/baselines/); where the
structured approach pays off most - larger repositories, stronger models -
is not yet measured. A complete worked example lives in
[examples/bookmark-service](examples/bookmark-service/README.md).

## Documentation

- [Why spc](docs/why-spc.md) - what it gives you, what it does not, and when to skip it
- [Getting started](docs/usage/getting-started.md) - from zero to a verified run
- [Spec authoring reference](docs/usage/spec-authoring.md) - every field, criterion type and identifier rule
- [CLI reference](docs/usage/cli-reference.md) - every command, flag and exit code
- [Configuration reference](docs/usage/configuration.md) - every `.spc/config.yaml` option
- [Workflows](docs/usage/workflows.md) - recipes: features, drift, invariants, parallelism, CI
- [Agent harnesses](docs/usage/agent-harnesses.md) - running spc through ZCode and friends: JSON output, the harness provider, and the bundled `.agents/skills/spc` skill
- [Follow-ups and approvals](docs/usage/followups-and-approvals.md) - the human loop, gates and waivers
- [Diagnostics reference](docs/usage/diagnostics.md) - every SPC code and runtime error
- [Architecture](docs/architecture.md) and [ADRs](docs/adr/) - the decisions and their reasons
- [CI integration](docs/ci-integration.md) - requirement status on pull requests
- [Benchmark harness](evals/README.md) and [baselines](evals/baselines/)

## Quick start

Built from this repository for now (npm packaging is planned):

```bash
git clone https://github.com/scott-thornton/spec-as-code
cd spec-as-code
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
alias spc='node "$PWD/packages/cli/dist/main.js"'
```

Try the vertical slice against a fixture (deterministic - no live model):

```bash
tmp=$(mktemp -d) && cp -R fixtures/simple-node-service/. "$tmp"/ && cd "$tmp"
git init -b main && git add -A && git commit -m init
node <this-repo>/packages/cli/dist/main.js init          # or configure manually
node <this-repo>/packages/cli/dist/main.js spec validate specs/greeting.yaml
node <this-repo>/packages/cli/dist/main.js plan specs/greeting.yaml
node <this-repo>/packages/cli/dist/main.js apply
node <this-repo>/packages/cli/dist/main.js status
node <this-repo>/packages/cli/dist/main.js diff
node <this-repo>/packages/cli/dist/main.js followups
```

The fixtures use the deterministic **fake provider** (scripted responses in
`.spc/fake-script.yaml`), so everything above runs offline. For real
repositories, configure an OpenAI-compatible provider in `.spc/config.yaml`:

```yaml
provider:
  name: openai
  model: gpt-4.1          # any chat-completions model
  # baseURL: https://your-gateway/v1   # optional
  # apiKeyEnv: OPENAI_API_KEY          # default
```

## Commands

```
spc init                          create specs/, .spc/, default config; report (never persist) detected commands
spc spec validate <file>          compiler diagnostics + spec digest
spc spec show <file> [--format]   generated Markdown/text view
spc plan <specFile>               observe repo, generate plan, validate (repair ≤2), persist
spc plan validate [file]          validate a persisted plan against its spec
spc plan show [file]              render the plan
spc plan approve <planId>         approval marker for requirePlanApproval
spc apply [planFile]              preflight → isolated worktree → sequential DAG execution →
                                  write-scope enforcement → verification → summary
                                  (--resume <runId> recovers interrupted runs)
spc verify [specFile]             run acceptance criteria against the current tree (drift detection)
                                  --format github emits CI annotations + a step summary
spc reconcile [specFile]          verify; when drifted, plan the next transition (--apply to execute)
spc run pr <runId>                generate a PR title/body from run records (§82)
spc status [specFile]             requirement-oriented status with evidence provenance
spc diff [specFile]               desired vs observed
spc followups                     structured queue (blocking / non-blocking)
spc followup resolve <id>         --option/--run/--note; produces human evidence when criterion-linked
spc run show <runId>              full run summary from persisted records
```

## Writing a spec

```yaml
apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: oauth-login
  title: GitHub OAuth Authentication
goal: >
  Users can authenticate using GitHub OAuth without breaking existing
  password authentication.
requirements:
  - id: AUTH-001
    statement: Users can authenticate using GitHub OAuth.
    priority: must                      # must | should | may
    acceptance:
      - id: AUTH-001-A
        type: command                   # deterministic evidence
        command: node --test "tests/*.test.mjs"
        expect: { exitCode: 0 }
      - id: AUTH-001-B
        type: file
        path: src/auth/github.ts
        assert: { exists: true, contains: "passport-github" }
constraints:
  - id: AUTH-C01
    statement: OAuth access tokens must not be stored in plaintext.
    acceptance:
      - id: AUTH-C01-A
        type: agent                     # model-derived evidence (flagged)
        instruction: Inspect token persistence.
      - id: AUTH-C01-B
        type: human                     # indeterminate until resolved
        instruction: Review the consent screen UX.
outOfScope: [Google OAuth, enterprise SSO]
```

Requirement states are qualitative: `unknown`, `in_progress`, `satisfied`,
`unsatisfied`, `indeterminate`, `waived` - never percentages.

## Repository layout (operating inside a project)

```
specs/*.yaml               desired state (committed)
.spc/config.yaml           provider + policy (committed)
.spc/plans/                generated plans (ignored)
.spc/worktrees/<runId>/    execution isolation, branch spc/<specId>/<runId>
.spc/runs/<runId>/         events.jsonl / evidence.jsonl / observations.jsonl
                           (append-only), state.json (projection), followups.json,
                           summary.md, amendments/, plan-vN.json
```

## Packages

`@spc/schema` → `@spc/core` → `@spc/repo` / `@spc/llm(+fake/openai)` →
`@spc/planner` / `@spc/executor` / `@spc/verifier` → `@spc/runtime` →
`@spc/cli`, plus `@spc/renderer` for one-directional human views. See
[docs/architecture.md](docs/architecture.md) and the ADRs in `docs/adr/`.

## Safety model

- Execution happens in a dedicated Git worktree; dirty repositories are
  refused at preflight; nothing is merged or pushed automatically.
- Per-task write scopes are enforced against the **actual git delta**, not
  agent claims (`OUT_OF_SCOPE_WRITE`).
- Commands are classified (test/build/lint/inspect allowed; network, push,
  publish, destructive denied by default; installs/migrations gated) with
  timeouts and secret redaction before persistence.
- Repository content is treated as untrusted data; permission checks live in
  code, never in prompts.

## Spec composition (imports)
**Also in the run loop:** requirement `category` tags (§80) with the SPC1009
high-assurance warning; approval-gated acceptance commands (§52) - approval-class
commands produce an approval follow-up and only run after
`spc followup resolve <id> --option approve`; `environment.requiredSecrets`
(§53) presence-checked at apply preflight (values never read); tiered
amendment approval (§31, `execution.amendmentApproval: tiered`) where
high-risk amendments (lockfiles, migrations, deploy config) are gated behind
a blocking follow-up with the amendment preserved for review; and
`spc run cancel <id>` for interrupted runs.


Shared invariants live once and compose into feature specs (ADR-0014):

```yaml
imports:
  - ./_invariants.yaml   # org-wide SEC-*/policy properties
```

The composed graph compiles as one spec: cross-file `dependsOn` resolves, the
digest covers every file in the graph (plan staleness works across imports),
ID collisions across files are rejected rather than rewritten, and import
cycles are compile errors.

## Self-hosting

The tool verifies itself: `specs/self-hosting.yaml` (SELF-001 through SELF-008 from §90)
states the tool's own requirements, `.spc/config.yaml` is committed, and CI
runs `spc verify --format github` on every PR (see
[.github/workflows/spc-verify.yml](.github/workflows/spc-verify.yml)) - the
tool proves itself on itself, with requirement-oriented PR annotations.

## Fixtures

- `fixtures/simple-node-service` - failing requirement → plan → bounded
  execution → verification → `GREETING-001 satisfied` with deterministic
  test evidence.
- `fixtures/plan-replan-service` - planner targets the wrong path; the
  executor records an observation, the task moves to `needs_replan`, a plan
  amendment replaces it with the correct target, execution resumes and
  succeeds with the original plan preserved in the run directory.

## Status of the project

Experimental V0, complete and self-verifying. The benchmark harness
([evals/README.md](evals/README.md)) compares this workflow against a plain
Markdown-plan baseline on 30 tasks with withheld grading, and every result -
scripted, real-model and adversarial-gate runs - is committed unaltered under
[evals/baselines](evals/baselines/), including what the tool lost and the
fixes that followed. Parallel execution (§78, ADR-0012) is implemented:
`execution.parallelism` runs ready tasks with disjoint write sets
concurrently in per-task worktrees, merged deterministically. CI reporting
(`spc verify --format github`, see
[docs/ci-integration.md](docs/ci-integration.md)) and drift reconciliation
(`spc reconcile`) are available now. What is not yet measured: real-sized
repositories - that is the open question.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md); day-to-day contributor rules (for
agents and humans) live in [AGENTS.md](AGENTS.md). CI verifies the tool's
own spec on every pull request.

## License

[MIT](LICENSE) - Copyright (c) 2026 Scott Thornton.
