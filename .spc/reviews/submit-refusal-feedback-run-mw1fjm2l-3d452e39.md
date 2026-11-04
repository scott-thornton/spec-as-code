# adversarial review: submit-refusal-feedback / run run-mw1fjm2l-3d452e39

Target: spec submit-refusal-feedback (digest sha256:0aec1ad0...), run
run-mw1fjm2l-3d452e39, commit range 49aab4a..a91df2a plus the
between-runs rectification ops (packages/cli/src/commands/agent.ts).

## pass 1 — reviewer (subagent, adverse-review, RAM-constrained)

Findings:

- **F-01 HIGH** contract gap — recordRefusalFeedback wrote lastError at
  the client gates even when an unconsumed VALID answer existed,
  un-arming the duplicate-submission guard (store.answer refuses an
  unconsumed answer only while lastError is unset) and smearing the
  pending answer as "Prior answer (invalid)". Reproduced end-to-end
  through the real CLI with a clean A/B control: gate-refused submit on
  an answered-but-unconsumed request -> next duplicate submit silently
  overwrote the valid answer; control request (no prior gate refusal)
  correctly refused with REQUEST_ALREADY_ANSWERED. The spec's
  store-boundary exclusion protected the store door; the client gates
  delivered the same hazard through the front door.
- **F-02 LOW** compliance — the committed inline marker "· feedback"
  broke queue-legibility QL-004's pinned "retry" hint; reverted in the
  working tree (detail line stays neutralized to "feedback:" - the
  lying "previous answer invalid" frame is gone).
- **F-03 INFO** drift risk — the preflight fallback string had the
  exact "preflight refused" shape SF-003 forbids; unreachable today but
  a future exit-1 path without an onRefusal call would silently regress.

Exonerated: REQUEST_* store-door exclusion (no write, empirically);
respond chain door inside the defect-if; window untouched (no third
argument anywhere in the client, expiresAt byte-identical); bounded
shape (single-line applicator messages, 610 chars empirically); onRefusal
exactly at the three real refusal sites; show's FEEDBACK section gated;
second identical refused submit behaves identically (feedback write
changes nothing when no answer exists).

## rectification — fixer (main agent), between-runs patch leg

- F-01: recordRefusalFeedback no-ops when store.hasAnswer(id) - a
  client-gate refusal of the new draft never touches a request whose
  valid answer awaits consumption; stdout teaching stands alone.
- F-03: fallback now names the drift ("an exit-1 path in spc agent
  dry-run lacks its onRefusal call - report this").
- F-02: marker revert committed with the rectification.

## result — proved by spc verify

- targeted suites (submit-refusal-feedback, queue-legibility-cli,
  agent-submit, unmediated-guard): 18/18 green
- full cli battery: 56 files / 230 tests green
- spc verify specs/submit-refusal-feedback.yaml: all satisfied, exit 0
- spc verify --all: exit 0

In-run SF-004 verdict (EV-0009) was a role-timeouts timing flake under
in-run load (unrelated package); standalone battery green. Sign-off:
main agent, after proof.
