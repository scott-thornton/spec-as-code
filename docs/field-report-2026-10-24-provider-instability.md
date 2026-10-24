# Field report: provider instability against the run machinery

October 2026.

## Scope and disclosure

This report covers the 2026-10-23/24 work programme in the
self-hosting repository: seven shipped changes (anchor verification,
dependency-blind lint, verification preparation, notes anchoring,
records and replacement, failure classification, board staleness).
During that programme, the model provider serving the answering agent
failed mid-turn five times. Each failure ended the agent's turn
abruptly; the session resumed after re-prompting, with context
reconstructed from records. Two of the five interruptions exceeded two
hours.

This is a report on what spc's machinery did while its operator was
repeatedly offline.

Disclosures that bound every claim below:

- **n = 1 session, and the operator is the tool's builder.** The
  recovery paths taken were the ones the builder already knew existed.
  Nothing here establishes how a stranger's session recovers.
- **The reporting agent is the component that failed.** The provider
  deaths being reported killed the turns of the same agent writing
  this report. Incident facts below are taken from records (run
  events, the harness stale queue, CI history), not from memory of the
  interrupted turns.
- **No injected-failure baseline.** The interruptions were operational
  accidents, not a controlled fault-injection experiment; windows,
  timing, and what was in-flight during each are circumstances, not
  variables.
- **The corrupted-run contrast case is one prior incident**
  (run-mvix4mfx, 2026-10-22). The before/after claim is one event
  against one event.

## Usage at a glance

| Metric | Value |
|---|---|
| Provider interruptions (mid-turn) | 5 |
| Longest dead windows | ~2h 3m and ~2h 2m (three others under 20m) |
| Runs interrupted by expiry | 2 apply attempts across the programme |
| Requests swept to the stale queue | 4 executor + ≥1 planner window expired outright |
| Corrupted run records | 0 |
| Runs recorded failed-empty by expiry | 1 (run-mvlggyi2, `LLM_HARNESS_RESPONSE_TIMEOUT`) |
| Continuation runs used to recover | 5 across the programme |
| CI full-board verifications during the window | 6 consecutive green on isolated runners |

## What the machinery did

### Expired windows failed empty, never complete

The apply attempt interrupted by a dead window (run-mvlggyi2) recorded
`TASK_FAILED` with `LLM_HARNESS_RESPONSE_TIMEOUT` and completed as
failed with unsatisfied properties — no task verdicts, no phantom
completion. The run is legible forever as "the answer never arrived."
Nothing downstream inherited a satisfied requirement from it; the
spec's eventual green came from a continuation run that re-established
its red phase at the interrupted base and flipped honestly.

### Dead requests were retired, not answered later

Four executor requests expired out of the live queue into
`.spc/harness/stale/`, plus at least one planner window. The expiry
sweep exists so that a later, context-reconstructed session cannot
answer a request whose planning premises no longer match the tree.
During a night of repeated context reconstruction, that hazard was
live, and the sweep retired it each time.

### The concurrent-writer class did not recur

The prior incident in this lineage (run-mvix4mfx, 2026-10-22, before
the execution lock shipped) had provider instability plus a mistimed
resume producing two concurrent writers on one run: duplicate evidence
ids, a broken hash chain, a permanently load-refusing log. This
programme carried the same stressor — five interruptions, multiple
resumes — against the fenced system and produced zero corrupted
records. Two honest caveats: the lock never had to fire this time,
because the dead windows happened to fall in turns that were not
mid-composition (luck, not design margin); and the before/after is one
incident against one incident. What is attributable is narrower and
sufficient: the machinery that did fire — window expiry, fail-empty
task records, continuation ancestry — failed in the correct direction
on every occurrence.

### Scope enforcement held under resumed-session confusion

Two of the programme's apply attempts were refused
`OUT_OF_SCOPE_WRITE` — the operator's plan write-targets were narrower
than the change set (a wrong-package path; a missing file). These were
operator errors, not provider errors, but they occurred in exactly the
condition provider instability manufactures: a session resuming from
reconstructed context, re-deriving a plan it had partly forgotten. Both
refusals reverted the change sets; nothing landed undeclared. The
fail-closed boundary was exercised at its most valuable moment.

## What the instability did not cause

A concurrent symptom — rotating multi-suite failures across local
board sweeps (17 → 2 → 3 unsatisfied across three runs, different sets
each time) — was initially suspected of being provider-caused,
directly or through processes orphaned by dead turns. The
investigation:

1. **Direct mechanism excluded by construction and control.** Board
   criteria are pure local processes; the harness provider only waits
   on a file-backed queue. Six consecutive CI board runs — the
   identical sweep, isolated runners, *no answering agent at all* —
   were green across the incident window, including the exact commit
   that flaked 17 locally. A network-dependent criterion would have
   hung CI, not passed it.
2. **The orphaned-compute hypothesis was checked and retracted.** The
   flaky sweeps ran while the session was alive and serial; the dead
   windows contained no in-flight builds. An initial concession that
   orphaned processes might have fed the flake did not survive the
   timeline check and is withdrawn here rather than left standing.
   (The lingering-process class is real on this workstation — two
   esbuild services from another repository, days old — it simply was
   not this incident's cause.)
3. **A capture harness settled the residue.** Three full `--all`
   passes on the frozen green tree produced zero failures (204
   satisfied each, ~16 min per pass). The flake decomposes into one
   real defect the board correctly caught (a typecheck error invisible
   to the build gate, since fixed) plus load-conditioned noise on an
   8GB workstation during heavy concurrent agent use. The deferred
   worker-cap change was *not* implemented: three clean passes did not
   support its mechanism. Data: `docs/board-flake-capture-2026-10-24.md`.

The instability's real costs were the ones in the table above: one
honestly-failed run, several burned windows, and wall clock. Nothing
else.

## Costs

- ~4.5 hours of dead windows across the night, plus re-verification of
  interrupted work.
- One sacrificed run, preserved as an honest expiry failure — the
  record-keeping cost of never guessing.
- The human operator as the outermost retry loop: five re-prompts. The
  system below the agent recovered autonomously every time; the agent
  layer did not, because a dead turn stays dead until re-prompted. The
  guarantees held at a layer below the component that was failing.

## What the experience earned the roadmap

One concrete gap, born of observed need: **composition time is an
availability risk the tool can see.** Rehearsed executor answers
routinely exceed the 15-minute role window; under provider instability
they exceed it while the operator is also losing whole turns, and the
expiry class compounds. The discipline that emerged — compose and
rehearse fully off the clock, submit within seconds of the re-dispatched
request — should become affordance: draft against a request, submit
against its successor without re-deriving. That removes the
composition-time expiry class entirely, and it is the one piece of this
incident the current machinery cannot fix by itself.

Secondary: keep the capture harness ready and re-run it the moment the
board flake reappears under load, letting that evidence decide the
worker-cap question; and sweep for orphaned build/test processes
before local board runs on shared workstations.

## The three reports together

The consumer report showed refusal-to-lie under production ticket
pressure. The self-hosting report showed the same refusal directed at
the tool's own author. This report shows the refusal surviving a
condition neither stressed: the operator's own availability failing
repeatedly mid-transaction. All three arrive at the same place from a
third direction — the deterministic boundary holds precisely where the
probabilistic participant, including its provider, does not.

## Provenance

Incident records: `.spc/runs/run-mvlggyi2-3b82eaa1` (expiry failure),
`.spc/harness/stale/` (expired requests), run-mvix4mfx (prior-incident
contrast, load-refusing by design). CI evidence: six consecutive green
`spc-verify` runs, 2026-10-23T01:59Z through 2026-10-24T02:11Z.
Capture data: `docs/board-flake-capture-2026-10-24.md`. Interruption
count and window lengths corroborated by the session transcript;
everything material to claims is from records.
