# adversarial review: criterion-challenge disjointness + chains / run run-mw88o1xp-8d58aecb

One read-only pass on the delta (81fb5ff..9069370, apply 69e85b6):
SHIP-QUALITY, no F1. The delta is conservative in every
verdict-affecting path: disjointness can only downgrade
discriminating to inconclusive, per-op staging can only refuse
more, never less. Gate order verified (infra legs ->
invalid-baseline -> non-discriminating -> disjointness ->
signature): signatureInBaseline cannot rescue or mask any earlier
verdict, and legacy callers passing nothing keep exact semantics -
the new gate sits strictly after every pre-existing one. The live
record corroborates: skew-carveout discriminating with
signatureInBaseline false at the apply commit.

Fixed post-run (0598d46, disclosure): F2-2 the CLI report printed
"signature: detected" under inconclusive-by-disjointness - a
detection the classifier withheld, unnamed; now names the
disqualifier and suppresses the disqualified world's line. F2-1/F3-7
doc note: disjointness spans the ENTIRE baseline pipeline (echoes,
prepare-skip line) - generic tokens (install, build) are
in-baseline by construction; fixture authors must choose signatures
the baseline cannot produce. Report-surfacing only; rule boundary
stated in the commit (verdict-computing code is what demands a
fresh run; additive output over passing criteria does not).

RECORDED NOT TAKEN (conservative-direction or cosmetic): innocent
baseline occurrence forces inconclusive - letter-mandated by the
amended CHAL-003 (a token present in both worlds attributes
nothing); makes the regression guard hostage to baseline build
noise; the remedy is precise fixtures, never a looser gate.
signatureLine recorded under disqualified outcomes (independent
observations, boolean pair explains). Per-op staging diverges from
batched semantics for patch-after-delete (refusal-direction,
pathological ordering). Mid-chain refusal detail does not disclose
partial application (worktree discarded; leg honestly
inconclusive). Dead write/delete counters on the success path.

Oracle adequacy: classifier pins both directions; the loose fixture
rides the durable payload path-echo (fails loudly if the payload
shape changes); the chain fixture pins no-refusal and the verdict -
bounded weakness: a trailing delete means it proves the chain does
not REFUSE, not that every patch applied.

Run accounting: partially_satisfied is honest. The amendment forked
the spec digest (b51c87d4), so the chain restarts and CHAL-001-B -
a CLI pin that discriminated the run which BUILT the command
(run-mw81uztk, old digest) - is indeterminate here and forever
under this digest unless re-flagged as the regression guard it now
is (the CHAL-004-A precedent, operator authority required).
CHAL-004 satisfied via the de-flagged guard evaluating pass-at-base
- the amendment's cure working as intended. Stage-6 verify: all
six satisfied, 100% reuse, tree clean through it (the record
untracking also working as intended).

Proof: stage-6 verify exit 0; CLI oracle 4/4 and engine oracle
11/11 after 0598d46; CI watched on the satisfaction commit.
