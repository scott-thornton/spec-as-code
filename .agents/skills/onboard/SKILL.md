---
name: onboard
description: Adopt spc in a repository - init, config, first spec, CI. Use when introducing spc to a new repo, when a user asks to set up spec-driven work somewhere, or when configuring provider and command policy from scratch.
---

# onboard: adopting spc in a repository

## Setup

```bash
spc init                      # specs/, .spc/, config, gitignore lines
```

Commit `.spc/config.yaml` and `specs/` - they are the contract layer,
meant for review. `.spc/runs`, `.spc/plans`, `.spc/worktrees` and
`.spc/harness` are tool state; `spc init` adds the ignores.

## Config decisions that matter early

- **Provider**: `harness` when an agent session should answer model
  requests through files (no API key spent by spc itself); `openai` /
  `anthropic` compat endpoints for unattended runs; `none` still gives
  the deterministic half (validate, verify command/file criteria,
  status, diff).
- **Command policy**: defaults deny network, deployment, publish, push
  and destructive ops, and gate installs/migrations behind approval
  follow-ups. Keep them; loosen deliberately, never by habit.
- **Isolation**: worktrees by default; `execution.inPlace: true` to run
  in the checkout on the run branch (clean tree, parallelism 1);
  `inPlaceBranch: current` to commit directly on the checked-out branch.

## First spec: ticket to contract

Take the ticket or request and extract checkable claims. One spec per
concern, kebab-case id. Every must gets acceptance criteria before any
planning happens (see `author-spec` for criteria craftsmanship).
Validate immediately:

```bash
spc spec validate specs/<name>.yaml
```

Then the loop: `spc plan` (read the plan before applying), `spc apply`,
`spc status`. Prefer small first specs - the loop's value shows up in
the second and third spec, once the team trusts the verify step.

## CI

Add a verify job so requirement status appears on every PR:

```yaml
# .github/workflows/spc-verify.yml
- run: npx @spc/cli verify --format github
```

Unsatisfied musts become error annotations; the summary gets a
per-property table. Humans still decide merges - spc only reports.

Start every session in an spc repository with `spc brief` - the
one-command orientation: specs with their last runs and blocking
follow-ups, the pending harness queue, config posture, unmerged run
branches. Read-only, instant, and it replaces the opening minutes of
git archaeology.
