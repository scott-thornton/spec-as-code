# Field report: the operator's provider died five times mid-surgery

**Date:** 2026-10-23/24 · **Environment:** spec-plan self-hosting (in-place
runs, `inPlaceBranch: current`, harness provider, 8GB macOS workstation) ·
**Reporter:** the agent operating the tool (GLM via z.ai), i.e. the
instrument reporting on its own outage

## Scope

During the 2026-10-23/24 work programme (seven shipped slices: anchor
verification, dependency-blind lint, verification preparation, notes
anchoring, records-and-replacement, failure classification, board
staleness), the model provider serving the operating agent failed
mid-turn five times. Each death ended the agent's turn abruptly; the
human re-prompted ("You errored out boss man. Continue."), and the
session resumed with reconstructed context. Two of the five dead
windows exceeded two hours.

This report records what spc's machinery did during those windows, what
it refused to do, what the instability actually damaged versus what it
was suspected of damaging, and what it cost. The headline: **five
provider deaths, multiple interrupted runs, zero corrupted records.
Every failure spc recorded during the incident was true.** The guards
built in response to earlier field incidents were exercised by a real
operational condition and held.

## What actually happened, mechanically

Three distinct "timeout" classes were in play and are worth separating,
because two days of diagnosis initially conflated them:

1. **Provider deaths** — the operating agent's turn killed mid-flight
   by its model provider. Five occurrences, windows of roughly 2h, 9m,
   7m, 19m, and 2h.
2. **Harness role-window expirations** — spc's own 900s windows on
   pending planner/executor requests, expiring while the operator was
   dead or composing. Four requests were swept to
   `.spc/harness/stale/` (`executor-T001@1-33`, `@1-38`, `@1-40`,
   `@1-42`); at least one planner window (`planner-planner@1-42`)
   expired outright.
3. **Local board flake** — rotating multi-suite verification failures
   on the workstation. Initially suspected of sharing a cause with (1);
   ruled out (see "Forensics").

## The casualty list - and the non-casualties

| Event | What spc recorded | What it prevented |
| --- | --- | --- |
| Executor request expired during a dead window (run-mvlggyi2, records-and-replacement attempt 1) | `TASK_FAILED` with `LLM_HARNESS_RESPONSE_TIMEOUT`, then `RUN_COMPLETED status=failed` with unsatisfied properties - an honest empty failure | A phantom completion. The run is legible forever as "the answer never arrived" |
| Same, planner side (planner-planner@1-42) | Request expired out of the live queue into `stale/` | A later, context-reconstructed session answering a dead request whose planning premises no longer matched reality |
| Agent resumed and re-applied plans against runs whose first attempts had died | Continuation runs with validated ancestry (`--parent`), red phases re-established at the interrupted base | The concurrent-writer corruption class - compare the incident below |
| Two composition-time scope errors by the (recently restarted) operator | `OUT_OF_SCOPE_WRITE` refusals, change sets reverted, nothing landed | Undeclared writes riding in on the confusion of a resumed session |

The comparison that frames the whole report: **run-mvix4mfx** (2026-10-22,
*before* the execution lock existed) — provider instability plus a
mis-timed resume produced two concurrent writers on one run, duplicate
evidence ids, a broken hash chain, and a permanently load-refusing log.
**This incident** (2026-10-23/24, *after* run-exclusion shipped) — five
deaths, multiple resumes, zero corrupted logs. Same stressor, opposite
outcome. The lock serializes execution; the expiry machinery retires
dead requests; the continuation path re-establishes flips honestly at
a red base. The delta between the two incidents is exactly the fencing
that the first incident motivated.

One clarifying detail: the lock did not have to *fire* this time,
because the dead windows happened to fall in turns that were not
mid-composition (read-only exploration, or waiting on a board). That is
luck, not design margin. The mechanism that did fire every time was the
role-window expiry - and it failed in the correct direction on every
occurrence.

## Forensics: what the instability did NOT cause

The local board flake (rotating unsatisfied criteria across board runs,
17 → 2 → 3 across three sweeps) was initially suspected of being
provider-caused, directly or through orphaned processes left by dead
turns. The investigation, in order:

- **Direct mechanism ruled out by construction and by CI:** the board's
  criteria are pure local processes; the harness provider only waits on
  a file-backed queue. Five consecutive overnight CI board runs - the
  identical sweep, on isolated runners, with *no answering agent at
  all* - were green on the exact commit that flaked 17 locally. If any
  criterion needed the network, CI would have hung, not passed.
- **Indirect channel (dead turns orphaning compute) checked and
  retracted:** the flaky sweeps ran while the session was alive and
  serial; the dead windows contained no in-flight rehearsal builds. The
  concession that orphans *might* have fed the flake did not survive
  the timeline check. (The class is real - two esbuild services from
  another repository had been lingering on this workstation since
  Tuesday - it simply was not this incident's cause.)
- **Final capture:** three full `--all` passes on the frozen green tree,
  zero failures (204 satisfied each, ~16 min per pass). The flake is
  load-conditioned noise on an 8GB workstation during heavy concurrent
  agent sessions, plus one real defect the board correctly caught (a
  typecheck error that `pnpm build` could not see). Results:
  `docs/board-flake-capture-2026-10-24.md`.

The instability's real casualties were exactly the ones in the table
above: one honestly-failed run, several burned planner/executor
windows, and wall clock. Nothing else.

## Costs

- **Wall clock:** roughly 4.5 hours of dead windows across the night,
  plus re-verification of interrupted work.
- **One sacrificed run** (run-mvlggyi2), preserved forever as an honest
  `LLM_HARNESS_RESPONSE_TIMEOUT` failure - the record-keeping cost of
  never guessing.
- **The human as the outermost retry loop:** five re-prompts. The
  system below the agent recovered autonomously every time; the agent
  layer did not, because a dead turn stays dead until re-prompted. That
  boundary is worth naming: spc's guarantees held at a layer *below*
  the component that was failing.

## Findings

1. **The guard set survived its first real operational stressor.**
   Lock, expiry sweep, fail-empty task records, continuation ancestry,
   fail-closed scope enforcement - all exercised, all held. The
   corruption of run-mvix4mfx is now attributable to a specific missing
   fence, not to provider instability in general.
2. **Fail-empty beats fail-complete.** The most valuable single
   behavior: a run whose answer never arrived recorded unsatisfied and
   stopped. Nothing downstream inherited a phantom.
3. **Composition time is an availability risk the tool can see.**
   Executor answers assembled through scratch-worktree rehearsal
   routinely exceed 15 minutes; under provider instability they exceed
   the role window *and* invite the dead-window expiry. The working
   pattern that emerged - rehearse fully, then submit within seconds of
   the re-dispatched request - should eventually become affordance
   (compose off the clock, submit on it), not discipline.
4. **Forensic separation of timeout classes pays for itself.** The CI
   control (no answering agent, still green) settled in minutes what
   local reasoning had gotten wrong for a day. When a system has a
   deterministic layer, run the experiment that isolates it.

## Recommendations

- Keep the capture harness (`scripts/board-flake-capture.mjs`) ready;
  re-run it the moment the flake reappears under load, and let that
  evidence decide the deferred worker-cap change (M1 was *not*
  implemented: three clean passes did not support the mechanism).
- The orphan-process sweep before local board runs remains cheap
  hygiene on shared workstations.
- A future affordance: answer composition decoupled from the request
  window (draft against a request, submit against its successor
  without re-deriving), which would remove the composition-time
  expiry class entirely.

## Provenance

Incident records: `.spc/runs/run-mvlggyi2-3b82eaa1` (harness timeout
failure), `.spc/harness/stale/*` (expired requests), run-mvix4mfx
(prior-incident contrast, load-refusing by design). CI evidence:
six consecutive green `spc-verify` runs across the incident window
(2026-10-23T01:59Z through 2026-10-24T02:11Z). Capture data:
`docs/board-flake-capture-2026-10-24.md`. Operator: GLM (z.ai) under
ZCode, session of 2026-10-22/24; the five interruptions and their
windows are corroborated by the session transcript.
