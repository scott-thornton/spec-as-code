# adversarial review: reproduce-verification / runs run-mwa4vb67, run-mwa57cy4, run-mwa5bo8b, run-mwa65avj, run-mwa6c18k

Order 3: spc reproduce <runId> - re-execute a run's recorded
verification at its committed result revision through the existing
verify --run machinery (spawned, not refactored) after a comparability
preflight, then compare per criterion: reproduced / diverged /
not-comparable / inconclusive, with the session's attribution rule
(infrastructure in the NEW execution - or a cache replay - is
inconclusive, never divergence; the machine failing to observe is not
the artifact failing to reproduce). Original records only ever read.

Pass 1 (full delta): NEEDS-RECTIFICATION. F1-1: per-RECORD comparison
fabricated diverged on any healthy apply run - red-phase records are
base-revision observations the evaluator itself excludes, and this
repo's requireRedPhase makes them routine (demonstrable against this
delta's own runs). F1-2: the preflight never checked the spec that
will actually EXECUTE - the child verify --run resolves the CURRENT
tree, so spec drift could masquerade as artifact divergence. F2s:
child death dressed partial as complete; concurrent-run
misidentification; empty evidence -> vacuous green; cache replays
silently certifying the cache; sentinel wording; unguarded parses.

Rectified across run-mwa65avj + two disclosed post-run fixes:
latestByCriterion (phase-red filtered, last-per-criterion, both sides
- the evaluator's own semantics); reusedFrom -> inconclusive (wired to
the verifier's real payload field); the currentSpecDigest comparability
leg (drifted INSTRUMENT text, never artifact divergence); REPRO_NO_RERUN
on child death, REPRO_AMBIGUOUS_RERUS on concurrent ambiguity,
REPRO_NO_EVIDENCE on empty originals; per-line parsing with badLines
named; established-nothing exits 1. Pass 2 (confirmation): SHIP-QUALITY
- every channel verified at file:line against the real writers, no
regressions; the faithful fixture (red + duplicate records) collapses
correctly.

RECORDED NOT TAKEN (sub-bar): child output printed twice on the death
path (cosmetic); well-formed lines without criterionId skip silently
(docblock slightly overbroad); a current spec that fails to compile
skips the current leg but the child dies SPEC_NOT_FOUND -> fail-closed
downstream; a criterion whose only records are red vanishes from rows
(never established - defensible, unnamed); fresh-only criteria
unreported (comparison anchored per original - the letter's mechanics);
suite digests enforced by construction (child resolves at the same
revision) rather than a named preflight leg; the ev-orig-1 prefix pin
cannot distinguish duplicate selection (both dups supports; unit pins
the collapse).

Run history: run-mwa4vb67 (failed - child CLI path dist/dist,
noUncheckedIndexedAccess, report wording; fixed+disclosed),
run-mwa57cy4 (green halves; the trailing-run cost of post-run
rectification), run-mwa5bo8b (all five satisfied via synthesis - first
full demonstration), run-mwa65avj (rectification landed; REPRO-002
in-run, two small post-run fixes), run-mwa6c18k (all five satisfied).
Stage-6 verify exit 0 (100% reuse). 19/19 oracles.

Proof: CI watched on the satisfaction commit.
