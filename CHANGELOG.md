# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning.

## [0.2.0] - 2026-10-15

### Added

- Budgets as signals (execution.budgets: wallTimeMs, diffLines,
  changedFiles): evaluated at run completion and reported via
  BUDGET_SIGNAL events and non-blocking follow-ups. Deliberately never
  enforced - unexpected size is state for the human, not a failure.

- The audit spine. Events are hash-chained: each event carries the
  digest of its predecessor, so editing, inserting, deleting or
  reordering any event breaks the next pointer on load (legacy logs
  replay as unchained-but-strict; partially-chained logs are rejected;
  resumed legacy runs stay legacy). Every run completion writes a
  prefix attestation (attestation.json + RUN_ATTESTED) committing to
  { event count, event chain head, evidence head, result revision,
  status } - later legitimate events extend the chain without
  invalidating it. verification.attestInGit (opt-in) anchors the
  commitment as an empty commit with SPC-Attestation-* trailers on the
  run branch. New `spc run replay <runId>` verifies the whole spine:
  strict loads, chain, state.json projection (field-level divergence
  reporting) and attestation. Verified against the real production
  corpus (51 historical event logs, 2,063 evidence records, zero false
  positives); SELF-023.

- Trust and integrity pass. docs/threat-model.md states the boundary
  plainly: write scopes are not an OS sandbox, command policy is a
  guardrail against accidents, specs are executable configuration -
  spc governs negligent agents, it does not contain malicious ones.
  Audit loads fail closed: corrupted or schema-invalid interior
  events/evidence are loud errors instead of silent omissions, evidence
  digests are recomputed on load (tolerating only a torn trailing line
  from an interrupted append); verified against 5,934 real events and
  2,063 evidence records from three weeks of production usage with zero
  false positives. New `spc policy explain <command>` shows command
  classification, the matched pattern and the effective policy.

- Protected verification assets (`verification.protectedPaths`): glob
  patterns no task may change regardless of declared write targets -
  an agent that can modify its own oracle can manufacture green, so a
  task touching a protected path fails with PROTECTED_PATH_WRITE and
  the write is reverted before the retry (without the revert, the
  retry inherited the file, its delta came back empty, and the task
  completed with the forbidden change in the tree). The revert is
  generalized to ALL delta-level violations, including out-of-scope
  writes from criterion commands (executor-proposed writes were already
  blocked by the pre-flight before touching the tree). Authoring
  guidance documents the oracle provenance ladder (mutable, protected,
  external, withheld) and the gates-read-not-write rule.

- `spc run export <runId>`: a self-contained evidence bundle - run
  directory verbatim, spec file with import closure, plan, full
  base..result diff, config as of export, and a manifest.json hashing
  every component (sha256) for standalone audit; warns loudly when the
  spec changed since the run. Evidence now survives the workstation
  and the CI job.
- Machine-provenance commit trailers: task and result commits carry
  SPC-Run-Id, SPC-Task-Id and SPC-Spec-Digest in the message body
  (git interpret-trailers format) alongside the human author, so the
  repo stays self-describing without .spc. Parallel cherry-picks
  preserve trailers.

- Harness answering reliability pass (from three weeks of real
  usage telemetry): `spc agent validate <id> --file` preflight-checks a
  draft answer against the request schema before submitting; the
  harness response timeout now refreshes on each invalid-answer requeue
  (capped at 5) so an actively-iterating agent is not starved by the
  rounds it already spent; after an in-place run-branch run the report
  states where results live, and verify/reconcile warn when the
  unmerged results branch would report as phantom drift.

- Process skills and the commands to serve them: nine curated skills
  (core loop, adverse-review primitive, adversarial-pr loop,
  adversarial-loop for the same choreography without a PR, rectify,
  author-spec, answer-queue, handle-partial, onboard) shipped under
  .agents/skills as the source of truth; `spc skills` lists them and
  `spc use-skill <name>` prints one for the current agent. Repo-local
  .agents/skills override bundled copies; the CLI bundle is synced at
  build time so skill content is pinned to the tool version.

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
  blocks a succeeded status. Flip enforcement is scoped to apply runs:
  standalone `spc verify` never demands red evidence, so satisfied specs
  keep verifying green after the fact, including in CI. Resume never re-runs the sweep; enabling the
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

- Run commits attribute to you: task commits, result commits and parallel
  cherry-picks defer to the repository's configured git identity (author
  and committer), so attribution, blame and history stay with the human
  whose contract ran. The fixed `spc <spc@local>` identity remains only
  as a fallback for environments where git cannot resolve an identity at
  all (bare CI runners), where the commit would otherwise fail.
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
