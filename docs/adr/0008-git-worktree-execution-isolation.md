# ADR-0008: Git worktree execution isolation

Date: 2026-09-17
Status: accepted

## Context

Agent execution must never dirty a developer's working tree, must be rollback-
safe, and must produce reviewable diffs. Concurrent isolation must be possible
later without redesign.

## Decision

Each apply run creates a Git worktree under `.spc/worktrees/<runId>` on branch
`spc/<specId>/<runId>`. Preflight refuses a dirty source repository (override
with `--allow-dirty`). After the scheduler finishes, changes are committed to
the branch (identity `spc <spc@local>` if the repo has none configured) and
`RUN_COMPLETED` records base and result revisions. V0 never merges or pushes;
humans review and merge normally. Failure runs keep the worktree for
inspection. Per-task write-scope enforcement diffs the actual worktree status
(`git status --porcelain -uall`) against declared write targets — never
trusting agent claims.

## Consequences

- The developer workspace is structurally untouched.
- Rollback is branch/worktree disposal; nothing clever at the application level.

## Alternatives considered

- Execute in place with checkpoint commits: one mistake away from ruining a
  developer's tree.
- Docker sandboxes: heavier than V0 needs; command policy covers the gap.
