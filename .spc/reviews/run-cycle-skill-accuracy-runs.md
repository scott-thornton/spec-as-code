# adversarial review: run-cycle-skill-accuracy / runs run-mwv83r4p, run-mwvabi8l, run-mwvap2i3, run-mwvaycap

The run-cycle skill (.agents/skills/run-cycle/SKILL.md) is the operating
procedure a model loads before driving spc from inside a tool harness.
Written on 2026-11-16 from one repository's experience, it stated four
things that were not true and omitted what 2026-11-24 proved. This cycle
makes it say what is true. It took one correction and three
rectifications: each read-only adversarial pass against the code found
what the previous correction had written.

## What the skill says now

- The executor answer carries commands, observations,
  evidenceCandidates and followups, required by the request's schema
  even when empty; validate before every respond.
- spc run cancel: a run that no execution-intent record names is marked
  cancelled at once; otherwise cancel completes when the owner is parked
  on a request; on macOS it prints "cancellation INCOMPLETE" and exits 1
  after 30 s. The way out is spc apply recover, once no spc process is
  writing.
- One writer per path: a later task is refused UNMEDIATED_CHANGES when
  its declared write targets overlap a path an earlier task changed,
  even if it never touches it.
- The rehearsal (spc agent dry-run, no --gates) checks out the run's
  base plus one draft. It is faithful only for a task that depends on
  nothing in flight, earlier or later; red does not convict the answer
  when the task's criteria need another task's work. A refused staging
  is a wrong operation, an overlap, or - in a worktree-mode run - the
  task's own earlier applied work. spc patch verify checks composition
  only. spc agent respond refuses exactly one shape on rehearsal
  grounds (PREFLIGHT_ADVISABLE).
- A run that changes the red-phase / oracle-identity gate cannot
  validate its own repair: a fresh spc verify is the evidence. Any
  other indeterminate is a finding.
- Verify one spec or N: spc verify <id> <id>, by path, file stem or id.
  Bare spc verify runs every spec. vitest exits 0 when a title filter
  selects no test.
- Diagnose from the tail of captured output (cut to its first 64 KiB),
  skipping red-phase records.

## Run history, disclosed

- Spec and oracle committed; run-mwv83r4p (plan-20261124-005): SUCCEEDED,
  7/7. The first apply run since the oracle-identity gate shipped in
  which an in-run flip established through it on the pnpm --filter
  shape: RCS-007-A red "6 failed (6)" then green "6 passed (6)", the
  same oracle path and digest at both revisions, zero COUNTERFACTUAL_REPLAY
  events. This is the end-to-end observation the oracle-relative-paths
  review listed as an open oracle gap.
- Adversarial pass 1 on the text: FIX FIRST. One F1 - "a criterion still
  red in the rehearsal means the answer is wrong", although the
  rehearsal checks out the run's base plus one draft. Three F2 - every
  run touching the evidence packages told to expect indeterminate;
  CANCEL_INCOMPLETE named, a string the CLI never prints; --gates build
  recommended, which only repeats the build the rehearsal already does.
  Spec amended (three properties; 14 file criteria red); run-mwvabi8l.
- Pass 2: FIX FIRST. A residual F1 - red is structural for any task
  whose criteria need another task's work, earlier or later. Three F2 -
  a refused staging conflated with red; a garbled sentence my own edit
  left in the one-writer bullet, which my string check passed; "exactly
  one shape", although respond also exits 1 on other grounds. Amended
  (six criteria red); run-mwvap2i3.
- Pass 3: FIX FIRST. One F2 - in a worktree-mode run a refused staging
  can be the task's own earlier applied work (it cannot arise in this
  repository's in-place runs, but the skill ships to every
  configuration). One F3 - the overlap refusal stated precisely, and an
  overlap is remedied by re-planning. Amended (four criteria red);
  run-mwvaycap.
- Pass 4, on the two changed sentences only: PUSH. One F3 (below).
- After every run, spc verify in a fresh process: all ten properties
  satisfied, about 5 s.

## Why the rectification runs read passed-at-base

A criterion already green at base cannot flip; it is restored only by
inheriting the earlier run's flip. File criteria never inherit.
Measured: computeChainFlipMemory returns a file criterion's flip when no
oracle gate is passed, and nothing when one is; apply.ts always passes
one (packages/runtime/src/chain-memory.ts:108-124 - the branch for a
criterion without a command text continues without establishing). A
defect in specs/oracle-identity-wiring (2026-11-14), invisible until
2026-11-24 because the gate was rejecting everything. It is the top of
the backlog: until it is fixed, every re-run or amendment leaves each
already-green file criterion's property indeterminate in the apply run's
ledger. The command criterion flipped in all four runs.

## RECORDED NOT TAKEN

- F3, pass 4: the table's "the last case needs nothing" is true of the
  operation but not of the submission in a worktree-mode run - the CLI
  checks against the live checkout, not the run's tree, so submit stops
  at its rehearsal without --no-preflight and respond refuses a patch on
  a file the task modified earlier. Wording: "needs no fix; submit it
  with --no-preflight".
- The other skills and the CLI itself still recommend a bare
  `spc agent dry-run --gates`, which runs every root gate including the
  full test battery (rehearse, pipeline, answer-queue, the harness prompt
  at packages/llm-harness/src/harness.ts:45, the PREFLIGHT_ADVISABLE
  message at packages/cli/src/commands/agent.ts:576). This matters on the
  operator's machine.
- The planner prompt still offers dependsOn ordering for overlapping
  writers (packages/planner/src/prompts.ts:14-15). answer-queue says the
  response window is about 15 minutes (it is 40-60). rehearse and
  pipeline demand submit, "never a bare respond".

## What this cycle taught the convenor

Three corrections of one document, each pass finding what the previous
one wrote. Write to the code, not from memory: every F1 and F2 was a
sentence composed from recollection. Check sentences, not strings - a
garbled sentence passed a substring check. Pin a phrase on one line or
the criterion is vacuous.

## CI, and what a sweep costs (recorded 2026-11-25)

- 087d634 (N-spec verify) and bd008c7 (oracle-relative-paths): green on
  both jobs. Their verify sweeps took 113 and 115 minutes.
- 65bcb9e (this spec): ci failed once and passed on re-run. The failure
  was packages/runtime/src/apply-cancellation.test.ts, "cancel retry
  after a first cancellation attempt is safe": the first spc run cancel
  returned non-zero with neither "cancelled" nor "INCOMPLETE" in its
  output. The test prints neither, so the cause is not recoverable from
  the log. No runtime code differed from the previous push, whose ci
  passed. Intermittent, not fixed. Its fixed three-second waits belong
  to the first increment of the cancellation program.
- 65bcb9e, spc-verify: attempt 1 was cancelled at the 150-minute job
  limit after 105 of 112 specs, none unsatisfied. The seven it never
  reached (verify-cache, verify-dedup, verify-failure-visibility,
  verify-selection, version-skew-guard, window-recalibration,
  window-rendering) were verified locally in between: all satisfied, 20
  minutes. Attempt 2 was green: 112 specs, 126 criteria executed, 307
  reused, 99 minutes.

Where a cold sweep's time goes (measured, 2026-11-25):

| What a sweep runs | Count | Each | Cold total |
|---|---|---|---|
| Criteria that run one test file | 347 | 1-7 s | about 12 min |
| Build prefixes (pnpm --filter X... build) | 276 | 4-5.5 s | about 20 min |
| Criteria that run a whole package suite | 43 | 174-280 s | about 158 min |

The 43 whole-suite criteria, across 41 specs, are the sweep. Each runs
every test file of a package, which the single-file criteria already
cover one by one. The ci job proves the same suites green once in about
six minutes; spc-verify re-proves them 43 times, serially.

PROPOSED, NOT STARTED (operator authorization required): a whitelisted
segment memo, so each suite and each build runs once per sweep instead
of once per criterion; sharding spc-verify by subset; a lint rule
against whole-suite criteria; condition polls in the process-level
tests.
