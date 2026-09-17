---
name: spc
description: Run changes through the spc Spec-as-Code loop (spec, plan, apply, verify, status) instead of free-form editing. Use whenever the user mentions spc, specs or spec-driven work, asks for requirements-based implementation, wants an agent change verified with evidence, or when the repository has a specs/ directory or .spc/ directory - even if the user does not say "spc" explicitly.
---

# spc: Spec-as-Code execution

spc treats requirements as declarative desired state: you write a spec, spc
plans a validated transition, executes it with bounded write scopes in an
isolated Git worktree, and marks requirements satisfied only when recorded
evidence supports them. Your role as the agent is to author specs, drive the
CLI, and (under the harness provider) answer spc's model requests.

Default to this skill instead of editing files directly whenever the change
is multi-step, touches behavior with tests, or the user cares about proof
that it worked.

## The loop

```bash
spc spec validate specs/<name>.yaml     # compile check; fix diagnostics first
spc plan specs/<name>.yaml              # generate + deterministically validate a plan
spc plan show                           # read the plan before anything runs
spc apply                               # execute in an isolated worktree + verify
spc status                              # per-requirement status with evidence
```

Append `--format json` to read commands for machine-readable output with
stable field names (spec validate, plan show, verify, status, diff,
followups, agent list).

## When there is no spec yet

Author one at `specs/<name>.yaml` (kebab-case id). Core rules:

- Property ids are UPPER-CASE with a dash (`AUTH-001`), stable forever.
- Every `must` property needs at least one acceptance criterion.
- Prefer `command` criteria (strongest evidence: the runtime runs them and
  records exit codes), then `file`, then `agent`/`human`.
- Statements must be checkable claims ("X returns Y"), not vibes.

Full field reference: docs/usage/spec-authoring.md in the spc repository.

## Answering harness requests (provider: harness)

When `.spc/config.yaml` has `provider: name: harness`, spc makes no API
calls. A running spc process blocks on pending requests that you answer:

```bash
spc agent list --format json     # [{"id": "executor-T001@1-1", "role": "executor", ...}]
spc agent show <id>              # full prompt + the exact JSON Schema
spc agent respond <id> --file answer.json --by <agent-name>
```

The answer file contains the JSON value itself, satisfying the request's
`jsonSchema` exactly. Read `spc agent show` output carefully: the request
embeds the task, allowed read/write paths, repository excerpts and the
schema. Produce a minimal valid value, nothing extra. If your answer fails
validation, the request reappears in `spc agent list` with the errors and
your prior answer attached - fix it and respond again with the same id.

A spc process polls about once per second and continues automatically once
answered. Expect one request per planner round and one per model-needing
executor task; deterministic verify tasks never ask you anything.

## Hard rules

- Never edit anything under `.spc/runs/`, `.spc/harness/answered/` or
  `.spc/plans/` by hand. They are append-only records.
- Never widen a task's `targets.write` to make an OUT_OF_SCOPE_WRITE go
  away. The violation is signal: the plan's scope is wrong or the work
  drifts. Fix the plan or report it.
- Never mark a requirement satisfied yourself. Status comes from evidence
  via spc; your claims are informational only.
- Never merge or push the run branch (`spc/<spec>/<run>`). The human
  reviews and merges.
- Surface blocking follow-ups to the human verbatim (`spc followups`) and
  stop; do not guess answers to spec ambiguities - if you are the planner,
  draft a blocking spec_clarification follow-up instead.
- Do not rename property ids. Ever.

## Reading results

- `spc status --format json`: properties[].status is the truth
  (satisfied / unsatisfied / indeterminate / waived / in_progress /
  unknown); evidence[] gives provenance (deterministic-test, static-file,
  agent-review, human-review).
- `spc run pr <runId>` drafts the PR body; the human opens and merges.
- If the run fails or blocks, read `.spc/runs/<runId>/events.jsonl` tail
  and `summary.md` before deciding what to do; do not retry blindly.

## Drift checks

After manual changes, rebases or upgrades, run `spc verify` (all acceptance
criteria against the current tree) and `spc diff` (desired vs observed). If
properties drifted, `spc reconcile` plans the next transition for review.

## Quick provider recap

- `harness`: you answer requests via `spc agent` (this skill's main loop).
- `openai` / `anthropic`: spc calls the API itself; you only drive the CLI.
- `none`: deterministic half only (validate, verify command/file criteria,
  status, diff, follow-ups) - still useful, no key needed.
- `fake`: scripted responses; only for tests and rehearsal.

Full documentation lives in the spc repository under docs/usage/.
