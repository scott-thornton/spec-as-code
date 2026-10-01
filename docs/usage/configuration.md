# Configuration reference

All configuration lives in `.spc/config.yaml` (created by `spc init`,
committed with the repository). Every option has a default; a file
containing only `version: 1` is valid. Unknown fields are rejected with a
typed error rather than ignored.

Complete annotated reference:

```yaml
version: 1

provider:
  # fake | openai | anthropic | none
  #
  # none    - no model calls; spec compile, verify with command/file
  #           criteria, status, diff and follow-ups all work. Planning and
  #           agent criteria need a real (or fake) provider.
  # fake    - deterministic scripted responses from the file named by
  #           `script`; used by fixtures and tests, useful for dry runs.
  # harness - no API calls: each model request is written to
  #           .spc/harness/pending/ with its JSON Schema, and any external
  #           agent (a coding harness or a human) answers via
  #           `spc agent respond`. See docs/usage/agent-harnesses.md.
  # openai  - any OpenAI-compatible chat-completions endpoint.
  # anthropic - any Anthropic-compatible messages endpoint (including
  #           GLM's coding endpoint).
  name: none
  model: ""            # required for openai/anthropic, e.g. glm-5.3
  baseURL: ""          # optional endpoint override
  apiKeyEnv: ""        # env var holding the key (default OPENAI_API_KEY or
                       #   ANTHROPIC_API_KEY per provider)
  script: ""           # fake provider only: path to the script file

execution:
  # Human gate before any execution: plans must be approved with
  # `spc plan approve <id>` first.
  requirePlanApproval: false

  # Cost controls. Runaway autonomous loops must be structurally impossible;
  # every one of these caps is enforced in code, not prompts.
  maxModelCalls: 50          # total provider calls per run
  maxReplans: 3              # plan amendments per run
  maxTaskRetries: 1          # retries per task after a failure
  commandTimeoutMs: 120000   # per command execution
  maxOutputBytes: 65536      # persisted stdout/stderr per command

  # §78 parallel execution: max concurrently executing tasks. 1 keeps
  # sequential semantics. Ready tasks run concurrently only when their
  # declared write sets are disjoint; overlapping writers stay ordered by
  # plan dependencies. Task patches merge deterministically into the run
  # branch; a merge conflict fails the task with EXECUTION_CONFLICT.
  parallelism: 1

  # Commit the run branch after each task passes its write-scope check
  # (message: "spc: task <id> (run <runId>)"), recording the revision on
  # the task state and in TASK_COMMITTED events. Default false: one result
  # revision per run; the per-task journey lives in events.jsonl.
  commitPerTask: false

  # Execute in the repository checkout itself, on the run branch
  # (spc/<spec-id>/<run-id>), instead of an isolated git worktree under
  # .spc/worktrees/. The checkout switches to the run branch for the
  # duration of the run and is restored to the original branch afterwards;
  # the run branch keeps the result commits (merge or PR it as usual).
  # Requires a clean tree (as always) and execution.parallelism 1.
  # spc-owned state (.spc/runs, .spc/plans, .spc/worktrees, .spc/cache,
  # .spc/harness) is never committed. A cancelled or interrupted run
  # leaves the checkout on the run branch; `spc apply --resume <runId>`
  # returns to it, or check out your branch manually.
  inPlace: false

  # §31 iteration: demote blocking spec_clarification follow-ups drafted by
  # the planner to non-blocking and proceed. The follow-ups are still
  # recorded and visible after the run. Measured to recover most of the
  # completion gap flash-tier models lose to over-cautious blocking
  # (ADR-0013).
  proceedOnClarificationFollowups: false

  # §31 tiered amendment approval:
  #   auto   - validate every amendment and continue (previous behaviour)
  #   tiered - compute risk from the amendment's operations; high-risk
  #            amendments are gated behind a blocking approval follow-up
  #            and preserved as <id>.gated.json for review (ADR-0015)
  amendmentApproval: auto

  # Extra high-risk write patterns for tiered approval, in addition to the
  # built-ins (package.json, lockfiles, migrations, Dockerfiles, compose
  # files, CI workflows, infra/terraform/k8s).
  highRiskWritePatterns: []

commands:
  # Policy classes for executed commands. Values: allow | approval | deny.
  #
  # allow    - runs without question
  # approval - never runs silently; verification produces an approval
  #            follow-up naming the exact command; after
  #            `spc followup resolve <id> --option approve` the exact
  #            command string is allowlisted and runs (ADR-0016)
  # deny     - never runs; verification records inconclusive evidence
  network: deny            # curl, wget, ssh and any URL argument
  packageInstall: approval # npm/pnpm/yarn/bun install|add|remove|update
  migration: approval      # migrate commands, prisma/rails/typeorm migrations
  deployment: deny         # kubectl, helm, terraform apply, vercel, netlify
  publish: deny            # npm publish, cargo publish, twine upload
  gitPush: deny            # git push
  destructive: deny        # rm -rf, git reset --hard, drop table/database
  unknown: allow           # commands that match no class; keep allow for
                           #   ordinary project commands, tighten at will

verification:
  # When false, a must property supported only by agent-review evidence
  # stays indeterminate: model-derived support is never silently promoted
  # to established fact. Enable only with eyes open.
  allowAgentOnlyMustRequirements: false

  # Red-phase verification: execute criteria marked `discriminating: true`
  # (see Spec authoring) once at the run's base revision, before any task,
  # and accept them only when they flip red -> green. A discriminating
  # criterion that already passes at base leaves its property
  # indeterminate - it does not test the change. Apply runs only: standalone
  # `spc verify` runs after the fact and cannot establish the flip, so with
  # this enabled its discriminating criteria report no_red_evidence.
  requireRedPhase: false
```

## Secrets

Specs declare `environment.requiredSecrets`; values live in the
environment, never in config or state. Preflight presence-checks each name
before any model call and blocks with a `missing_secret` follow-up when
one is absent. Output redaction before persistence covers any environment
value whose variable name looks like a secret (TOKEN, SECRET, KEY,
PASSWORD, CREDENTIAL and friends) with a minimum length, independent of
this list.

## What is deliberately not configurable

Per the plan's non-goals, there is no plugin system, no generic policy
language and no remote control plane. The options above are plain data,
validated by schema; anything not listed does not exist, and unknown keys
fail config parsing with the offending path named. If a knob you want is
missing, that is a feature request, not a documentation gap.
