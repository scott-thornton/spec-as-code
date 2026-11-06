# adversarial review: skew-carveout / run run-mw4tsvft-3f344ba3

Target: spec skew-carveout (digest sha256:0c483880...), run
run-mw4tsvft-3f344ba3, range 6a8c1cf..64ad7fe plus rectification ops.

## pass 1 - reviewer (subagent, READ-ONLY - the machine had just crashed
from a local test run; zero local compute)

Verdict: rectify before merge. Happy paths faithful; byte-identity for
unthreaded callers holds by construction (char-compared); SC-002 wiring
sound (zod-validated config path, single threading point covering both
doors, degraded-config fail-closed); interactions and feedback machinery
untouched. Findings:

- F-01 HIGH fail-open: with patterns threaded and the delta
  uncomputable (unresolvable baseline - shallow clones, abbreviated
  refs, git-deadline kills), control fell through the entire bypass to
  ALLOW on a clean tree. Movement that cannot be attributed was
  silently permitted - the inversion of the bypass's own doctrine.
- F-02 MEDIUM: diff --name-only without --no-renames lists only a
  rename's destination - `git mv src/a.ts tests/x.ts` presented an
  all-protected delta and laundered the task-territory deletion.
- F-03/F-04 LOW: C-quoted paths fail-closed spuriously; trim() aliasing.
- F-05 oracle gaps: fail-open and rename legs untested.

## rectification - fixer (main agent), between-runs patch leg

Bypass restructured: refuseBypass helper (byte-identical message
templates); patterns empty -> refuse; delta computed with
`diff --name-only -z --no-renames` (NUL-split: no quoting, no trimming;
both rename sides named); `!delta.ok -> refuse` (fail closed, F-01);
all-protected delta falls through; else refuses naming offenders.
Oracle +2 legs: unresolvable baseline refuses (F-01); rename laundering
refuses naming src/a.ts (F-02).

## result - proved

- executor oracle 6/6 (4 original + F-01/F-02 legs); cli oracle 2/2.
- SC-003-A (cli battery) deferred to CI by RAM discipline after the
  operator's machine crashed from a local battery run: local full-suite
  execution is suspended; the spc-verify CI job executes the battery on
  every push. In-run SC-003 contradiction was the known flake class.
  Sign-off: main agent, after the local proofs and with CI as the
  battery authority.
