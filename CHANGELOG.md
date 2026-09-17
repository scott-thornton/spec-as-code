# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning.

## [Unreleased]

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
