# Getting started

This guide takes you from zero to a completed, verified run of `spc` in a
repository you own. Time needed: about ten minutes, plus one model call's
worth of patience per planning or execution step.

## What spc does

`spc` treats software requirements as declarative desired state. You write a
spec that says what must be true. The tool plans a transition, executes it
through bounded agents in an isolated Git worktree, and then verifies the
result by running your acceptance criteria. Requirements are marked satisfied
only when evidence supports them. An agent saying "done" is never enough.

The loop:

```text
spec (desired state)
  -> spc plan    (validated transition plan)
  -> spc apply   (bounded execution in a worktree + verification)
  -> spc status  (which requirements are satisfied, and why)
```

## Prerequisites

- Node.js 22 or newer
- Git
- If you build from this monorepo: pnpm 9+ (`npm i -g pnpm`)
- For real planning: an API key for an OpenAI-compatible or
  Anthropic-compatible endpoint. For trying things out with no key, use the
  built-in fake provider (see below).

## Install

From this repository (the current distribution method):

```bash
git clone <this-repo> spec-as-code
cd spec-as-code
pnpm install --frozen-lockfile
pnpm build
```

Make the CLI convenient to run:

```bash
alias spc='node /path/to/spec-as-code/packages/cli/dist/main.js'
```

Every command below assumes that alias. All commands also accept `--cwd` to
point at the target repository instead of `cd`-ing into it.

## Set up your repository

In the repository where you want to use spc:

```bash
cd your-repo
spc init
```

This creates:

```text
specs/            your spec files (commit these)
.spc/config.yaml  tool configuration (commit this)
```

`spc init` also prints any build, test, lint or typecheck commands it
detected. It never writes guesses into your config; if the detected commands
are right, copy them in yourself.

## Configure a provider

Planning and execution need a model provider. Edit `.spc/config.yaml`:

Anthropic-compatible endpoint (for example GLM's coding endpoint):

```yaml
provider:
  name: anthropic
  model: glm-5.3
  baseURL: https://api.z.ai/api/anthropic
  apiKeyEnv: GLM_API_KEY
```

OpenAI-compatible endpoint:

```yaml
provider:
  name: openai
  model: gpt-4.1
  # baseURL: https://your-gateway/v1   # optional
  apiKeyEnv: OPENAI_API_KEY            # default
```

Export the key before running:

```bash
export GLM_API_KEY=...
```

No key and just want to see the machinery work? Use the fake provider with a
scripted response file (this is what the test fixtures do):

```yaml
provider:
  name: fake
  script: .spc/fake-script.yaml
```

## Write your first spec

Create `specs/first.yaml`:

```yaml
apiVersion: spc.dev/v1alpha1
kind: Spec

metadata:
  id: first-feature
  title: My first feature

goal: >
  The service greets users by name.

environment:
  requiredSecrets: []     # optional; presence-checked only

requirements:
  - id: FEAT-001
    statement: greet(name) returns "hello, <name>".
    priority: must
    category: behavioral        # optional tag
    acceptance:
      - id: FEAT-001-A
        type: command
        command: node --test "tests/*.test.mjs"
        expect:
          exitCode: 0

outOfScope:
  - multilingual greetings
```

Rules that matter right now:

- Property ids (`FEAT-001`) are `UPPER-CASE` with at least one dash and
  never change once evidence references them.
- Every `must` property needs at least one acceptance criterion.
- `command` criteria are your strongest evidence: the runtime executes them
  itself and records exit codes, output digests and duration.

Validate it:

```bash
spc spec validate specs/first.yaml
```

You should see the property count, a clean checklist and a digest like
`sha256:...`. If not, the diagnostics point at file, line and column with an
excerpt, the same way a compiler does.

## Plan

```bash
spc plan specs/first.yaml
```

The planner reads your spec plus a bounded snapshot of the repository
(languages, manifests, test locations, likely relevant files) and returns a
plan: an ordered task graph with explicit read and write targets per task.
The plan is validated deterministically before you ever see it. If it does
not pass validation, the planner gets the diagnostics and retries, at most
twice, then fails visibly.

Inspect what was generated:

```bash
spc plan show
```

The plan is stored under `.spc/plans/<plan-id>.json` and names the spec
digest it was planned against. Change the spec and the old plan is stale;
`spc apply` will refuse it.

## Apply

```bash
spc apply
```

What happens, in order:

1. Preflight: spec digest matches the plan, the plan validates, your working
   tree is clean, no blocking follow-ups are open, any required secrets are
   present.
2. An isolated Git worktree is created on branch
   `spc/<spec-id>/<run-id>`. Your working directory is never touched.
3. Tasks execute in dependency order (or in parallel when
   `execution.parallelism` is above 1 and write sets are disjoint). Each
   task may only write inside its declared targets; the actual Git diff is
   checked against those targets, not the agent's claims.
4. Every command, file change and model call becomes an append-only record
   under `.spc/runs/<run-id>/`.
5. Verification runs your acceptance criteria in the worktree and derives
   per-requirement status from the evidence.
6. The result is committed to the run branch. Nothing is merged or pushed.

Then look at the outcome:

```bash
spc status      # per-requirement status with evidence provenance
spc diff        # desired vs observed, one line per property
```

## Follow-ups: how the run talks to you

Anything the run needs from a human becomes a follow-up, not prose in a log:

```bash
spc followups
```

Example output:

```text
BLOCKING

F-001  Missing secret: DEPLOY_TOKEN   (run run-ab12)
    Export it and re-run.

Resolve with: spc followup resolve <id> --run <runId> --option <optionId> [--note <text>]
```

Resolution is itself recorded as an event and, where a follow-up is linked
to an acceptance criterion, produces human evidence that feeds requirement
status.

## Verify anytime

`spc verify` runs all acceptance criteria against your current working tree,
independent of any run. Use it after manual changes, rebases or dependency
upgrades to detect drift:

```bash
spc verify
```

And to go one step further, `spc reconcile` verifies and, if properties have
drifted, plans the next transition for your review:

```bash
spc reconcile           # verify + plan if drifted
spc reconcile --apply   # also execute the transition
```

## Where things live

```text
specs/                     authored desired state (committed)
.spc/config.yaml           configuration (committed)
.spc/plans/<id>.json       generated plans (ignored)
.spc/runs/<run-id>/        per-run records (ignored)
  events.jsonl             append-only event log
  evidence.jsonl           append-only evidence
  observations.jsonl       facts discovered during execution
  followups.json           structured human queue
  state.json               projection over events (rebuildable)
  summary.md               human run summary
  amendments/              plan amendments (with .gated.json for gated ones)
.spc/worktrees/<run-id>/   isolated execution worktrees (ignored)
```

## Next steps

- [Spec authoring reference](spec-authoring.md) - every field, criterion
  type and identifier rule
- [CLI reference](cli-reference.md) - every command, flag and exit code
- [Configuration](configuration.md) - every option in `.spc/config.yaml`
- [Follow-ups and approvals](followups-and-approvals.md) - the human loop
- [Diagnostics reference](diagnostics.md) - every error and warning code
- [The bookmark-service walkthrough](../../examples/bookmark-service/README.md)
  - a full loop on a realistic service with a real model
