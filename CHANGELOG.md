# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning.

## [Unreleased]

### Added

- In-place execution on the current branch (`execution.inPlaceBranch:
  "current"`): with `execution.inPlace`, runs can execute and commit on
  whatever branch is checked out - no branch switching at all, base
  revision still recorded. Detached HEAD is refused; resuming requires
  being on the run's branch. Default remains the dedicated run branch
  (`"run"`), which keeps a run one reviewable git range.
- Red-phase verification (`verification.requireRedPhase` + `discriminating:
  true` on command/file acceptance criteria): apply runs execute
  discriminating criteria once at the base revision before any task and
  record red-phase evidence; the evaluator accepts them only when they
  demonstrably flip red -> green. A criterion that already passes at base
  leaves its property indeterminate (decorative criterion exposed) and
  blocks a succeeded status. Resume never re-runs the sweep; enabling the
  flag mid-run surfaces no_red_evidence rather than faking base-revision
  evidence against a tree tasks already changed. New SPC1010 rejects the
  flag on agent/human criteria. Run summaries report flipped counts and
  non-flipped criteria under Remaining risk.
- In-place execution (`execution.inPlace`): runs execute in the repository
  checkout itself, on the run branch (`spc/<spec-id>/<run-id>`), instead
  of an isolated git worktree. The checkout switches to the run branch for
  the run and is restored to the original branch afterwards; the run
  branch keeps the result commits. Requires `execution.parallelism` 1.
  spc-owned state (`.spc/runs`, `.spc/plans`, `.spc/worktrees`,
  `.spc/cache`, `.spc/harness`) is now excluded from every result commit
  and from task write-scope deltas (a no-op in worktree mode, where the
  state lives outside the tree).
- Commit-per-task (`execution.commitPerTask`): each task's changes land on
  the run branch as their own revision once its write-scope check passes,
  with the revision recorded on task state and in `TASK_COMMITTED` events.
  Default remains one result revision per run. Run summaries now diff
  against the run's base revision, so runs with per-task (or parallel)
  commits report the full transition diff.

### Changed

- Verification sweeps execute each distinct command at most once:
  identical acceptance commands (same command, expected exit code and
  timeout) share a single execution per sweep, recorded as evidence for
  every criterion that names them. Specs that attach one global command
  (full test suite, typecheck) to several properties now pay for it once
  per sweep instead of once per criterion.
- Planner contract now states verification cost discipline (the final
  sweep always re-verifies every property, so mid-run verify tasks should
  not repeat expensive global criteria) and requires a minimum task set
  traceable to properties, to curb gold-plated plans.

### Fixed

- Executor-side clarification demotion (ADR-0013 addendum): a task that
  blocked with only clarification drafts under
  `execution.proceedOnClarificationFollowups` used to re-raise the same
  blocking clarification the planner's draft already had demoted. The
  executor now receives open clarifications with their recommended
  defaults, and clarification-only blocks are demoted and auto-retried once
  with proceed-on-default guidance (`CLARIFICATION_PROCEED`). Strict mode
  and non-clarification blocks are never demoted. Diagnosed via the
  api-version-header task blocking 3-for-3 on glm-5.3-flash; now 3-for-3
  completing.
- Benchmark corpus: the api-version-header spec omitted the header value
  its grading expected, so a defensible executor default failed hidden
  grading while the run honestly reported satisfied against its own
  criterion. The spec now carries the value.

### Added

- Harness mode in the benchmark runner (`spc-evals --provider harness`):
  an external coding agent answers every model request through files
  (zero API spend), including the fast adversarial gate
  (`evals/tools/harness-gate.sh` and `flash-gate.sh`).
- Post-fix full harness rerun (answering agent as model, both arms):
  30/30 tasks succeeded in both arms, zero blocked runs, zero false-done,
  regressions or forbidden changes - parity at ceiling; the pre-fix
  blocked-run residue is gone ([baselines](evals/baselines/real-glm-5.3-flash-2026-09-17.md)).
- Committed fast-adversarial gate results
  ([evals/baselines/fast-adversarial-2026-09-17.md](evals/baselines/fast-adversarial-2026-09-17.md)):
  full-tier run completed both arms 12/12 with zero friction; flash subset
  losses are all blocked runs, never bad edits.

## [0.1.0] - 2026-09-17

First tagged release: the complete V0 workflow plus the follow-up features
from the project plan.

### Added

- Spec compiler: YAML in, typed `SpecIR` + `sha256` digest out; compiler-grade
  diagnostics with source locations (SPC0001-0011, SPC1001-1009).
- Spec composition via `imports:` with composed-graph digests, cross-file
  `dependsOn`, id-collision rejection (ADR-0014).
- Validated planning: structured planner output, deterministic plan
  validation (coverage, cycles, verification paths, write conflicts) with
  bounded repair; `spc plan validate/show/approve`.
- Bounded execution: isolated Git worktree per run, sequential and parallel
  schedulers (per-task worktrees, deterministic patch merging, EXECUTION_CONFLICT
  on merge conflicts - ADR-0012), write-scope enforcement against the real
  Git diff, command policy classification, timeouts, secret redaction.
- Evidence-based verification: command/file/agent/human acceptance criteria,
  append-only evidence with trust-level provenance, requirement status
  derived from evidence; `spc verify --format text|github|json`.
- Requirement-oriented status: `spc status`/`diff` (text and JSON),
  `spc run show/pr/cancel`, PR draft generation.
- Follow-ups as first-class data: ten types, blocking semantics, resolution
  as human evidence, waivers; approval flow for policy-gated commands
  (ADR-0016).
- Explicit replanning: observations, plan amendments validated with history
  preserved, computed risk tiers with approval gating for high-risk
  amendments (ADR-0015), clarification demotion policy (ADR-0013).
- Recovery: event-sourced state projection, `spc apply --resume`,
  cancellation of interrupted runs.
- Drift: `spc reconcile` (verify + plan the next transition, opt-in apply).
- Providers: OpenAI-compatible, Anthropic-compatible, deterministic fake,
  and the harness provider where a coding agent answers model requests via
  `spc agent list/show/respond` files (ADR-0017); JSON output across read
  commands; bundled `.agents/skills/spc` skill and root AGENTS.md.
- Self-verification: `specs/self-hosting.yaml` states the tool's own
  requirements; CI runs `spc verify --format github` on every PR.
- Benchmark harness: 30 tasks across 10 categories with withheld grading,
  Markdown-plan baseline comparison, scripted and real-model baselines
  (glm-5.3-flash) including a measured iterate-and-remeasure cycle
  (completion gap from -21pp to -6pp), threshold derivation.
- Requirement categories (§80) with the SPC1009 high-assurance warning;
  `environment.requiredSecrets` presence-checked preflight (§53).
- Documentation suite: seven usage guides, architecture, 17 ADRs,
  CI integration guide, runnable bookmark-service example with a real-model
  transcript.

[0.1.0]: https://github.com/scott-thornton/spec-as-code/releases/tag/v0.1.0
