---
name: handle-partial
description: Triage runs that ended partially_satisfied, unsatisfied, blocked or stale. Use when spc verify or a run summary shows unsatisfied or indeterminate properties, when a run is still marked running but nothing is happening, or when the pending harness queue looks frozen.
---

# handle-partial: run triage

A partially satisfied run is information, not failure. Read the reasons
before touching anything:

```bash
spc status                     # per-property statuses
spc run show <runId>           # the summary
grep '"type":"PROPERTY_VERIFIED"' .spc/runs/<runId>/events.jsonl | tail
```

## Classify each unsatisfied/indeterminate property

- **Device, browser or live-e2e shaped** (the criterion contradicts
  because no in-agent verifier can run it): resolve the follow-up if a
  human ran it, or waive with human evidence recording the decision.
  Then fix the spec: that criterion was a `human` criterion wearing a
  `command` costume (see `author-spec`).
- **Genuinely broken**: the code fails the contract. Fix inside the
  original write scope and re-verify. Do not widen targets to make a
  violation disappear - the violation is the signal.
- **Criterion wrong** (imprecise pattern, wrong expectation): fix the
  criterion. Know that the spec digest changes and existing plans are
  refused (SPC2009) - re-plan. After meaningful runs existed, prefer a
  rectification spec (see `rectify`).
- **Contract gap** (nothing ever required this): do not patch code to
  satisfy it. Route to `rectify`.

## Waiver discipline

Waiving a must is a human decision recorded as evidence, not a way to
turn red green. Waive when a human actually judged it (ran the device
test, accepted the risk), and say so in the note. Never waive to make a
run report clean.

## Hygiene

- A run still marked `running` with nothing happening is abandoned:
  `spc apply --resume <runId>` to continue it, or `spc run cancel` to
  close it. Abandoned runs also block: open blocking follow-ups from any
  run of the same spec gate new runs.
- Old files in `.spc/harness/pending/` are requests nobody answered -
  usually belonging to an abandoned run. Cancel the run, then the queue
  entries can be cleared.
- Verify runs (v-*) are cheap and side-effect free; when in doubt about
  current truth, run `spc verify` again rather than trusting an old
  state file.
