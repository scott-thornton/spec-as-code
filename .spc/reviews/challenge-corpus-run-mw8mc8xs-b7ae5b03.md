# adversarial review: challenge-corpus / runs run-mw8hhuxm, run-mw8hwgfk, run-mw8mc8xs

The corpus: three archived defects replay discriminating on every CI
push - excerpt-crowding (1c946f7 -> ec13550, har's field report),
executor prompt update-op gap (1c946f7 -> 6a11435, take-seven),
non-streaming race-timer leak (62954d0 -> 54876bb, adapter-streaming
F6). All three fixtures verified DISCRIMINATING through the real CLI
before commit, zero corrections; committed byte-identical to the
verified bytes (extracted from the parked stash, not retyped).

Run history, honestly lumpy: run-mw8hhuxm failed on a REAL false-
signal defect the corpus surfaced - vitest 3's default forks pool
emits '[vitest-worker]: Timeout calling onTaskUpdate' as an unhandled
teardown error on child-heavy ~90s files: every test passes, exit 1
(vitest's own warning names the class). run-mw8hwgfk attempted an
async-spawn rewrite; that task failed on a harness timeout and the
run completed with 0 files changed - the rewrite never shipped, and
my interim claim that it "ruled out loop-blocking" rested on an
artifact that never existed (record corrected in a5c206b after the
adversarial pass caught it). run-mw8mc8xs carries the controlled A/B:
identical committed bytes, forks exit 1, threads exit 0 - the fix is
pool "threads" in packages/cli/vitest.config.ts, criterion commands
byte-identical, spec scope widened (df1a5df) with criterion
definitions untouched so the twice-recorded red flipped in-run.
Stage-6 verify exit 0 (91s).

Adversarial pass: SHIP-QUALITY, no F1. Every layer fails red on
non-discriminating, inconclusive, absent-fixture, and drifted-fixture
outcomes, with live proof of each red path in the run history.
Mutation faithfulness verified against the provenance commits;
disjointness recorded (signatureInBaseline false for all three);
anchors unique today; drift modes (vitest assertion wording, timing
separation under pathological load, anchor drift from refactors) all
fail red or inconclusive, never green.

RECORDED NOT TAKEN: full-suite threads audit deferred to CI on push
(in-worker process.exit surveyed absent; admission pinning identical
under both pools; failure mode is CI red, caught not silent). The
corpus tests pin status+discriminating+signature but not the
challenged criterion/provenance in stdout (the records carry them;
inaugural-oracle asymmetry, cosmetic). /discriminating/i also matches
non-discriminating (inert behind the exit-0 assert; latent trap if
exit semantics shift). Stale-dist masking window noted as a repo-wide
convention, not introduced here.

Proof: run-mw8mc8xs all three satisfied; stage-6 verify exit 0;
CI watched on the satisfaction commit (the ci battery doubles as the
full-suite threads audit).
