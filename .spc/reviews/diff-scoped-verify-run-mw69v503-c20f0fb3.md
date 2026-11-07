# adversarial review: diff-scoped-verify / run run-mw69v503-c20f0fb3

Read-only pass (API compute only - three crashes this session; zero local
execution by the reviewer). Verdict on the landed commit: FAIL as-is with
one HIGH; everything else exonerated with citations (default-path
byte-identity, no-footprint modulo F3, filter-union conservativity,
deletions, empty scopes, oracle soundness, command-cache additivity).

Findings and rectification (between-runs patch leg, cache invalidation
self-enforced by patch-fresh-build):
- F1 HIGH: unchecked git-diff failure -> empty changed set -> everything
  skippable -> vacuous "satisfied" board with a FALSE "proven disjoint"
  claim and git's error swallowed. FIXED: .ok guard, stderr surfaced,
  exit 2, refusal message; oracle leg added (bogus rev -> exit 2, no
  0-of-3 report). 5/5.
- F2 MEDIUM: suite criteria read `command` but the schema field is
  `ref` - the suite-skip branch was DEAD (suites never skipped; safe
  direction, but a spec divergence and a latent trap). FIXED: reads ref;
  suites now skip per DSV-001's letter.
- F3 LOW-MED: the throwaway scratch (evidence payloads carry full
  command output) was never removed. FIXED: rmSync before the banner.
- F4 LOW: failures built but never emitted (VF-001/VF-002 conventions).
  FIXED: text Unsatisfied block + json failures array.
- F5 LOW: github format degenerates to SKIP lines + banner (spec
  silent). RECORDED, not changed - partial mode is an operator-
  iteration surface; github annotations are CI's format and CI runs
  full verify.

Delivery notes: the third laptop crash interrupted the first submission
cycle (workspace recovered, plan re-applied, second run succeeded fully
in-run including the battery); one unmediated-changes refusal corrected
my own hygiene (validation edits left in the tree - the guard taught,
I reverted and proposed through the queue); the answer rode as UPDATE
ops - the op executor-prompt-update-op taught, used by its teacher.

Proof: oracle 5/5 (F1 leg included); standalone spec verify exit 0
(75% cache reuse); the run verified DSV-001..004 in-band.
