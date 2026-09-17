# spc — Spec-as-Code / Plan-as-Code (V0)

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

## Quick start

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

Try the vertical slice against a fixture (deterministic — no live model):

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
`unsatisfied`, `indeterminate`, `waived` — never percentages.

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

## Fixtures

- `fixtures/simple-node-service` — failing requirement → plan → bounded
  execution → verification → `GREETING-001 satisfied` with deterministic
  test evidence.
- `fixtures/plan-replan-service` — planner targets the wrong path; the
  executor records an observation, the task moves to `needs_replan`, a plan
  amendment replaces it with the correct target, execution resumes and
  succeeds with the original plan preserved in the run directory.

## Status of the project

V0 of an experimental workflow. The next milestone (per the project plan) is
the benchmark harness comparing this workflow against a Markdown-plan
baseline; no infrastructure (server, database, control plane) is planned
before that evidence exists.
