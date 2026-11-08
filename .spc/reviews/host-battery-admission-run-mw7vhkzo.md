host-battery-admission / runs run-mw7vhkzo + run-mw7w1yjs (both
cancelled; the work landed via the first run's finalize - see F2).
Read-only adversarial pass: PASS with findings; the code exonerated on
every probe (seam placement, lock lifecycle, shim completeness, config
flow, evaluate determinism).

- F1 MAJOR rectified: spc lint's baseline probe ran discriminating
  criteria with NO admission - a fresh criteria execution by the
  letter. FIXED: the probe admits (acquireHostAdmission exported,
  lint acquires; a held lock reports the probe not-executable,
  never a fabricated pass). Lint suites 7/7.
- F2 MAJOR RECORDED (not code): the cancelled run's finalize
  committed the apply INCLUDING evaluate.ts - a file outside the
  plan's write targets - while the run summary records zero
  out-of-target writes. The change itself was necessary and correct
  (the plan's assumption that reports already print reasons was
  wrong; the oracles required the token). The defect is run
  ACCOUNTING: drift recorded as zero against a result revision that
  contains an unplanned file. Backlog: run-accounting honesty
  (out-of-target writes in cancelled/finalized runs).
- F3 MINOR rectified: nested-verification ruling now a spec sentence
  (admission never waits; nested acquires refuse; unit tests pin
  per-suite paths - not host batteries).
- F4 MINOR rectified: SPC_ADMISSION_LOCK declared the test/routing
  seam in the spec (honored unconditionally; effect bounded by the
  one-operator-one-host scope).

Delivery notes for the record: the dogfood collision (sibling vitest
files + self-referential criteria refusing each other on the default
lock) was found by the run's own red criteria and answered by
per-suite lock pinning (combined six-file verifier suite 19/19); one
oracle correction (HBA-004 evidence-based file-criterion assertion -
the text report is property-granular); the plan's evaluate.ts
assumption failure was the only implementation divergence.

Proof: all six HBA properties satisfied (standalone verify exit 0,
twice - before and after rectifications); spec re-validated with
amendments (digest 45f5af98).
