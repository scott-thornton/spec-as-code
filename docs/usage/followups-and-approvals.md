# Follow-ups and approvals

Follow-ups are how a run asks a human for something. They are structured
data with ids, options and recorded resolutions, never prose buried in a
log. This page covers the full human loop: the follow-up queue, the
approval flows (commands, plan amendments, plans), waivers, cancellation
and recovery.

## The queue

```bash
spc followups
```

```text
BLOCKING

F-002  Approve command for DEP-001: pnpm add zod   (run run-c31d)
    The acceptance command is policy-gated ("packageInstall").
    Approving runs it during verification; rejecting keeps this property
    indeterminate.

NON-BLOCKING

F-001  Manual review: AUTH-C03   (run run-c31d)
```

Blocking follow-ups gate execution and completion; nothing proceeds past
one until it is resolved (or `spc apply --force` explicitly overrides).
Non-blocking ones record needed human judgment without halting other work.

## Resolving

```bash
spc followup resolve F-002 --run run-c31d --option approve
spc followup resolve F-001 --option confirm --note "Looks acceptable"
```

`--run` is only needed when the same follow-up id exists in several runs.
Every resolution is an event (`FOLLOWUP_RESOLVED`). When the follow-up is
linked to an acceptance criterion, resolution also records human evidence
and immediately re-derives the property status.

Criterion-linked resolutions:

| Option | Effect on the property |
| --- | --- |
| `confirm` | human evidence supports; can complete satisfaction |
| `reject` | human evidence contradicts; property unsatisfied |
| `waive` | property explicitly waived; excluded from must-satisfaction checks |

## Follow-up types

| Type | Typical producer | Blocking by default | Meaning |
| --- | --- | --- | --- |
| `spec_clarification` | planner | yes (demotable, see below) | The spec is ambiguous; a decision is needed |
| `approval` | verification / amendment gate | yes (command approvals non-blocking) | An action needs explicit permission |
| `missing_secret` | apply preflight | yes | A declared requiredSecret is not in the environment |
| `missing_environment` | executor | yes | Required tooling or environment absent |
| `manual_verification` | human acceptance criteria | no | A human judgment call is outstanding |
| `human_input` | executor | varies | Free-form human input needed |
| `spec_change` | planner | yes | The desired state itself needs changing |
| `investigation` | verifier / policy blocks | no | Something deserves a look, not a halt |
| `replan` | replan failures | yes | Replanning failed; the reason is attached |
| `post_run` | anything | no | Work for after the run |

## Command approval (§52)

Acceptance commands that fall in an `approval` policy class (installs and
migrations by default) never run silently. Verification records inconclusive
evidence plus an approval follow-up naming the exact command:

```text
F-002  Approve command for DEP-001: pnpm add zod
```

Resolve it:

```bash
spc followup resolve F-002 --option approve
spc verify          # the exact command string now runs
```

The allowlist entry is the exact command string, not its category:
approving `pnpm add zod` approves nothing else. Deny-class commands (network,
push, destructive) are unaffected by approvals and stay denied. See
[Configuration](configuration.md) for the policy classes.

## Plan approval (§73)

With `execution.requirePlanApproval: true`, `spc apply` refuses plans that
have not been approved:

```bash
spc plan approve plan-20260917-001
spc apply
```

Use this when you want a human checkpoint between planning and any
execution at all.

## Amendment gating (§31, tiered)

With `execution.amendmentApproval: tiered`, replanning goes through a
computed risk classifier:

- **low** - dependency additions, read-only tasks: validate and continue.
- **medium** - structural changes that touch no high-risk paths: continue.
- **high** - any introduced task that declares `risk: high` or writes a
  high-risk path (dependency manifests and lockfiles, migrations,
  Dockerfiles, compose files, CI workflows, infra/terraform/k8s, plus
  anything you add via `execution.highRiskWritePatterns`).

High-risk amendments are *not applied*. Instead the run:

1. preserves the full amendment as `amendments/<id>.gated.json` for review,
2. raises a blocking `approval` follow-up listing the operations and the
   reasons it was classified high-risk,
3. finishes `blocked`.

The triggering task stays `needs_replan` and the worktree keeps everything
already done. This is the mechanism that keeps "the agent decided to
rewrite the lockfile" a human decision.

## Clarification demotion (§31 iteration)

Flash-tier planners over-use blocking clarifications on specs that are
actually fine, costing completion for caution.
`execution.proceedOnClarificationFollowups: true` demotes blocking
`spec_clarification` drafts to non-blocking: the run proceeds with the
planned transition, the follow-ups remain recorded and visible, and the
planner's assumption is captured in the plan. Default stays `false` for
strictness. Measured effect on the benchmark: roughly two thirds of the
completion gap recovered with no safety regression (ADR-0013, baseline
addendum).

## Waivers

Some musts cannot or should not be satisfied right now. Waive through a
criterion-linked follow-up:

```bash
spc followup resolve F-007 --option waive --note "Deferred to next quarter by product"
```

Waived properties are excluded from run success checks, carry the human
decision as evidence, and render with the waived symbol in `spc status`.
Nothing is silently forgotten; the waiver is a first-class recorded fact.

## Cancellation

For a run left `running` by a crash or Ctrl-C:

```bash
spc run cancel <runId>
```

Marks it `cancelled` (terminal), so status is truthful, `--resume` refuses,
and preflight stops detecting it as an in-flight run. A live process cannot
be interrupted mid-task; there is no daemon by design.

## Recovery

If a run was interrupted but you want to continue it:

```bash
spc apply --resume <runId>
```

Events replay, state is rebuilt, a task found mid-flight is retried on its
next attempt counter, and completed tasks are never re-executed. If you
would rather abandon it, `spc run cancel <runId>` then start fresh.
