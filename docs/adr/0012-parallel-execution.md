# ADR-0012: Parallel execution via per-task worktrees

Date: 2026-09-17
Status: accepted

## Context

§78 defers parallel execution until sequential semantics are reliable. The
benchmark gate has now run (see evals/baselines/), the sequential engine is
covered by deterministic tests including recovery, and the follow-up policy
iteration re-measured — the §78 preconditions are satisfied in the only form
available without a live control plane.

## Decision

`execution.parallelism` (default 1) selects a parallel driver: ready tasks
whose write sets are disjoint execute concurrently, each in its own worktree
branched from the integration HEAD at launch. Completed task patches merge
back into the integration branch by deterministic cherry-pick. Because task
branches are cut from the post-merge HEAD and overlapping writers are
ordered by plan validation (SPC2007) plus a launch-time overlap gate,
cherry-pick conflicts are structurally prevented; the conflict handler
(abort + hard reset + `EXECUTION_CONFLICT` task failure + event) is
defense-in-depth and never resolves silently. needs_replan drains in-flight
tasks before amending. Parallel task worktrees are removed after merge.

## Consequences

- Independent tasks speed up wall-clock; ordering semantics are unchanged
  for overlapping writers (dependency-serialized, cumulative).
- Every merge is an explicit event (`PATCH_MERGED`), keeping runs auditable.

## Alternatives considered

- Shared worktree with in-memory locking: loses isolation; a crashed task
  would poison siblings' diffs.
- Rebase-per-task onto a moving integration branch: equivalent complexity,
  worse auditability than cherry-pick + events.
