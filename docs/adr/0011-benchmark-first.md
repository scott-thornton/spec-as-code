# ADR-0011: Benchmark-first gating for infrastructure work

Date: 2026-09-17
Status: accepted (gate executed — see evals/baselines/real-glm-5.3-flash-2026-09-17.md)

## Context

The project plan (§68, §78, §94, §103) is explicit: infrastructure beyond V0
— parallel execution in particular — is built only after the benchmark
demonstrates that the spec→plan→execute→verify abstraction improves outcomes
versus a Markdown-plan baseline, and numeric thresholds are set only after
real-mode variance stabilizes. The benchmark harness now exists
(`evals/runner`, 30 tasks, withheld grading), and a scripted-mode baseline is
committed (`evals/baselines/scripted-2026-09-17.md`), but scripted mode
validates harness mechanics, not the thesis. Real-model runs require provider
credentials and budget that are not available in this environment.

## Decision

1. The next milestone gate is a real-provider benchmark
   (`spc-evals --provider openai --trials ≥3`). No new orchestration
   infrastructure is built before that evidence exists.
2. Parallel execution via per-task worktrees and deterministic patch merging
   (§78) stays deferred until the benchmark justifies it. Building it now
   would optimize a workflow whose value is unproven.
3. What IS added now, because they are cheap, orthogonal and demanded by the
   follow-up list: drift `reconcile` (verify → plan the next transition,
   opt-in apply) and CI reporting (`spc verify --format github`).
4. Planner prompts are hardened with the §62 trap taxonomy (preserve-old-API
   verification, overlapping-writer serialization, blocking follow-up instead
   of hallucination) — prompt guidance only; the runtime already enforces the
   first two mechanically.

## Consequences

- Effort goes to measurement, not machinery.
- The real gate has now been run (3 trials × 30 tasks, glm-5.3-flash): the
  workflow did NOT beat the baseline on this model/task size (77% vs 99%
  completion, ~3× tokens), so the §94 response applies — iterate the
  abstraction (auto-resolution of low-risk clarification follow-ups, planner
  verification-path tuning), re-run the benchmark, and keep parallel
  execution / control planes deferred.

## Alternatives considered

- Building parallel execution now: rejected — §78 gates it on reliable
  sequential semantics AND benchmark evidence; only the first exists.
- Shipping thresholds with the harness: rejected — §68 forbids thresholds
  before stable variance.
