# CLI reference

Every command, flag and exit code. `spc` is short for
`node packages/cli/dist/main.js` when built from this repository (see
[Getting started](getting-started.md)). All commands accept `--cwd <dir>`
to operate on a repository other than the current directory.

Exit codes: `0` success; `1` validation or verification failure (the thing
you asked for is not true); `2` runtime error (bad invocation, missing
provider, Git failure and similar). Diagnostics carry stable `SPC*` codes;
see the [diagnostics reference](diagnostics.md). Read commands
(`spec validate`, `plan show`, `verify`, `status`, `diff`, `followups`,
`agent list`) accept `--format json` for machine-readable output with
stable field names.

## spc init

```bash
spc init [--cwd <dir>]
```

Creates `specs/` and `.spc/config.yaml` (defaults only), appends runtime
ignores to `.gitignore`, and prints any build/test/lint/typecheck commands
detected in the repository. Detected commands are never written into the
config automatically; review them and copy what is right.

## spc spec validate

```bash
spc spec validate <file>
```

Compiles the spec (parse, schema, semantics, composition) and prints
diagnostics with file, line and column, a summary checklist and the digest.
Follows `imports:` transitively. Exit `1` on any error-severity diagnostic.

## spc spec show

```bash
spc spec show <file> [--format markdown|text]
```

Renders the compiled spec as documentation (default `markdown`) or a
compact text listing, including category tags and declared secrets.
Generated views are never parsed back.

## spc plan

```bash
spc plan <specFile>
```

Observes the repository (bounded snapshot), builds planner context, calls
the configured provider, validates the returned plan deterministically and
repairs from diagnostics at most twice. Persists the plan to
`.spc/plans/<plan-id>.json` and prints coverage, execution order, expected
writes, assumptions and any drafted follow-ups.

Notes:

- Planning requires a provider; configure `provider.name` or the command
  fails with `NO_PROVIDER`.
- The plan records the spec digest and a repository snapshot digest.
- Blocking `spec_clarification` drafts print as BLOCKING; with
  `execution.proceedOnClarificationFollowups: true` they are demoted to
  non-blocking at apply time (see
  [Follow-ups and approvals](followups-and-approvals.md)).

## spc plan validate

```bash
spc plan validate [file]
```

Validates a persisted plan against its spec (found by spec id under
`specs/`, following imports). Without a file argument, validates the latest
plan. Prints every violation with its SPC code.

## spc plan show

```bash
spc plan show [file]
```

Renders a plan: header with spec digest and revision, requirement coverage,
task graph in execution order, expected writes, assumptions and drafted
follow-ups.

## spc plan approve

```bash
spc plan approve <planId>
```

Records approval for the plan. Only meaningful when
`execution.requirePlanApproval: true`, in which case `spc apply` refuses
unapproved plans and tells you to run this.

## spc apply

```bash
spc apply [planFile] [--resume <runId>] [--allow-dirty] [--force]
```

Executes a plan end to end:

1. Preflight: plan validates; spec digest matches; working tree clean
   (untracked `.spc/` state is ignored); no open blocking follow-ups from
   earlier runs of the spec; plan approved if approval is required;
   required secrets present.
2. Creates run records and an isolated worktree on
   `spc/<spec-id>/<run-id>`.
3. Executes the task graph. With `execution.parallelism > 1`, ready tasks
   with disjoint write targets run concurrently in per-task worktrees and
   merge deterministically into the run branch; a merge conflict becomes an
   `EXECUTION_CONFLICT` task failure, never a silent resolution.
4. Verifies every property from acceptance criteria and derives
   requirement status from evidence.
5. Commits the result to the run branch and prints a report. Nothing is
   merged to your branch and nothing is pushed.

Flags:

- `--resume <runId>` - continue an interrupted run; events are replayed,
  a task found mid-flight is retried on its next attempt, completed work
  is never re-executed.
- `--allow-dirty` - proceed with a dirty working tree (tracked changes;
  untracked `.spc/` never blocks).
- `--force` - proceed despite open blocking follow-ups from earlier runs.

Run end states: `succeeded` (all musts satisfied or waived, no blocking
follow-ups), `partially_satisfied`, `blocked`, `failed`, `cancelled`.

Related: `spc run cancel <id>` marks an interrupted run cancelled;
`spc run pr <id>` drafts the pull request.

## spc verify

```bash
spc verify [specFile] [--format text|github]
```

Runs all acceptance criteria against the current working tree, independent
of any run, and records a verify-only run. This is drift detection: run it
after manual changes, rebases or upgrades. Approval-class commands produce
approval follow-ups here too; approve and re-run.

`--format github` emits `::error`/`::warning` annotations per unsatisfied
property plus a Markdown summary table appended to
`$GITHUB_STEP_SUMMARY` when set. See
[CI integration](../ci-integration.md).

Exit `1` when any property is not satisfied or waived.

## spc reconcile

```bash
spc reconcile [specFile] [--apply]
```

Verify, then close the loop: if any property drifted, observe the current
tree and generate the next transition plan for review. Without `--apply`
the plan is persisted and you are told how to inspect and apply it; with
`--apply` the transition executes immediately. In-sync repos report as such
with exit `0`.

## spc status

```bash
spc status [specFile]
```

Requirement-oriented view of the latest run: per-property status grouped by
priority, the reason when not satisfied, evidence provenance
(deterministic-test, static-file, agent-review, human-review and the
outcome), task counts and open follow-ups. Without a run, all properties
show as unknown.

## spc diff

```bash
spc diff [specFile]
```

Desired vs observed, one line per property. The foundation of drift
monitoring; `spc reconcile` automates the response.

## spc followups

```bash
spc followups
```

Lists open follow-ups across all runs, blocking first, with run ids,
descriptions and, where defined, the options. Exit `1` while blocking
follow-ups remain.

## spc followup resolve

```bash
spc followup resolve <id> [--run <runId>] [--option <optionId>] [--note <text>]
```

Resolves a follow-up. `--run` is required when the same follow-up id exists
in multiple runs. When the follow-up carries an acceptance criterion,
resolution produces human evidence and re-derives the property status:
`confirm` supports, `reject` contradicts, `waive` waives the property.
Approval follow-ups with `--option approve` allowlist the exact command
they name for verification. Every resolution is an event.

## spc run show

```bash
spc run show <runId>
```

Prints the run summary (requirements, evidence provenance, follow-ups,
statistics, remaining risk) and the run directory location. Reconstructs
from persisted records, not chat transcripts.

## spc run pr

```bash
spc run pr <runId> [--out <file>]
```

Generates a pull-request title and body from run records: requirement
table with evidence, verification counts, open follow-ups, known
limitations. `--out` writes to a file. Nothing is posted anywhere; opening
the PR and merging remain human acts.

## spc run cancel

```bash
spc run cancel <runId>
```

Marks a run left `running` by an interrupted process as `cancelled`:
terminal state becomes truthful, `--resume` will refuse it, and preflight
stops suggesting it. There is no daemon, so a live process cannot be
signalled mid-task; cancel is for crash and Ctrl-C leftovers. Refuses runs
already in a terminal state.

## spc run list (DX note)

A `run list` subcommand is a known small gap; until it exists, list run
directories:

```bash
ls .spc/runs
```

## spc agent

```bash
spc agent list [--format text|json]
spc agent show <id>
spc agent respond <id> (--file <path> | --stdin) [--by <who>]
```

The harness-provider half of agent-harness integration: lists pending model
requests awaiting an external answer, prints one in full (prompt plus the
embedded JSON Schema the answer must satisfy), and submits an answer (a
JSON value, not a wrapper). Invalid answers requeue automatically with the
validation errors attached; valid answers are kept under
`.spc/harness/answered/` as the decision record. `agent list` exits `1`
while requests are pending. See
[Agent harnesses](agent-harnesses.md).

## spc-evals (benchmark harness)

Part of the evals toolchain rather than the product CLI; see
[evals/README.md](../../evals/README.md).
