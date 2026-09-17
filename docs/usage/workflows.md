# Workflows

Concrete recipes for the situations that recur. Each assumes the
[getting-started](getting-started.md) setup is done. Companion pages:
[CLI reference](cli-reference.md), [follow-ups and approvals](followups-and-approvals.md).

## Add a feature to a service you own

The canonical loop, on a repo with a test suite:

```bash
# 1. Write the spec: what must be true, how each claim is checked.
$EDITOR specs/my-feature.yaml
spc spec validate specs/my-feature.yaml

# 2. Plan; read what the planner intends before anything runs.
spc plan specs/my-feature.yaml
spc plan show

# 3. Execute in an isolated worktree, then verify.
spc apply

# 4. Inspect: which requirements are satisfied, and why.
spc status
spc diff
```

Review the run branch (`spc/<spec-id>/<run-id>`), then open a PR with the
generated draft:

```bash
spc run pr <runId> --out pr-draft.md
```

Nothing merges or pushes itself. When you like it, merge the branch with
Git as usual and delete the worktree directory.

## Catch drift after manual work, rebases or upgrades

You merged, then weeks of normal development happened. Is the spec still
true?

```bash
spc verify
```

Runs every acceptance criterion against the current tree and records the
result. Any property that regressed from `satisfied` to something worse is
drift, visible in `spc diff`. To go further:

```bash
spc reconcile            # drifted? plans the next transition for review
spc plan show            # inspect the proposed transition
spc apply                # execute it
```

`spc reconcile --apply` does both steps in one command when you already
trust the pipeline.

## Keep shared invariants across many specs

Security or compliance rules that apply to every feature belong in one
file, composed into each spec:

```yaml
# specs/_invariants.yaml
apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: org-invariants
  title: Organization invariants
goal: Invariants shared by every feature spec.
requirements:
  - id: SEC-001
    statement: Secrets are never committed under src/.
    priority: must
    category: security
    acceptance:
      - id: SEC-001-A
        type: command
        command: node --test "tests/security/*.test.mjs"
```

```yaml
# specs/feature.yaml
imports:
  - ./_invariants.yaml
```

Every composed plan must now cover and verify the imported properties, and
editing the invariants file invalidates every plan built against it, which
is the point. See the [spec authoring reference](spec-authoring.md).

## Work with a spec that needs secrets

```yaml
environment:
  requiredSecrets:
    - GITHUB_CLIENT_SECRET
```

```bash
export GITHUB_CLIENT_SECRET=...   # presence-checked; value never read
spc apply                          # blocked with missing_secret if unset
```

## Use parallel execution safely

Two kinds of work in one spec (say, backend module and docs page) that
write disjoint paths can run concurrently:

```yaml
execution:
  parallelism: 2
```

The scheduler only runs tasks together when their declared write targets
are disjoint; overlapping writers stay ordered by dependencies, patches
merge deterministically, and a merge conflict fails the task as
`EXECUTION_CONFLICT` instead of being resolved silently. Expect the biggest
wall-clock wins on plans with several independent modify tasks.

## Gate dangerous replanning

For repositories where "the agent decided to rewrite the lockfile" must
never happen silently:

```yaml
execution:
  amendmentApproval: tiered
```

High-risk amendments (lockfiles and manifests, migrations, Dockerfiles,
compose files, CI workflows, infra) are then preserved as
`amendments/<id>.gated.json`, a blocking approval follow-up describes them,
and the run finishes `blocked` for your review. See
[follow-ups and approvals](followups-and-approvals.md).

## Dry-run the machinery with no API key

The fake provider plays back scripted responses deterministically:

```yaml
provider:
  name: fake
  script: .spc/fake-script.yaml
```

`.spc/fake-script.yaml` keys planner responses and per-task executor
responses (see the fixtures under `fixtures/` for complete examples). This
is how CI exercises the entire pipeline with zero network access, and it is
a good way to rehearse a spec's verification before spending model calls.

## Require sign-off before any execution

```yaml
execution:
  requirePlanApproval: true
```

`spc apply` then refuses until you have run:

```bash
spc plan approve <planId>
```

Combine with tiered amendment approval when the repository warrants both
gates.

## Recover from an interrupted run

Two honest options:

```bash
spc apply --resume <runId>    # replay events, retry the interrupted task
spc run cancel <runId>        # or mark it cancelled and start fresh
```

Completed work is never re-executed on resume. A run found mid-flight is
retried on its next attempt counter with the failure context attached.

## CI: requirement status on every PR

```yaml
# .github/workflows/spc-verify.yml
- run: spc verify --format github
```

Unsatisfied musts become error annotations; indeterminate and non-must
failures become warnings; the job summary gets a per-property table with
evidence counts. Full recipe in
[CI integration](../ci-integration.md).

## What not to do

- Do not edit `.spc/runs/**` by hand; the event log is the source of truth
  and hand edits desynchronize the projection.
- Do not rename property ids mid-project; identity is load-bearing. If a
  requirement truly changed meaning, retire the old id and add a new one.
- Do not widen `targets.write` to make an out-of-scope violation go away;
  the violation is the signal. Either the task scope is wrong (fix the
  plan) or the agent is drifting (let it fail and look at the evidence).
- Do not treat `succeeded` as "tests probably pass"; it already means every
  must property is satisfied or waived with recorded evidence. The
  distinction you actually want is in `spc status`'s provenance lines.
