# decision-record req 5: the REAL CHAL-004-A history / runs run-mwhjsesr, run-mwhuuq5h

The ruling's implementation is complete: decision layer, cross-run
gate, counterfactual replay, creation-time snapshots, one classifier
in @spc/repo. This run closed the record's requirement 5 - the
demotion observable against the ACTUAL run-mw81uztk -> run-mw86ka7e
history. What the observation found:

**The gate fires on the real history.** Eight SYNTHESIS_REJECTED
events for CHAL-004-A in run-mwhuuq5h alone, pairing the real
ancestors (run-mw806npu red -> run-mw86ka7e green, real revisions
feecad74 -> 762496b7) - "oracle-unresolved (classification failed
closed)": at the red half's revision the snapshot cannot resolve, and
the ruling's conservatism refuses. Every synthesis candidate for
every criterion in this spec was judged and rejected. At the
CRITERION level, the demotion the record predicted is observable
exactly as specified.

**A second channel satisfies anyway - and that is a finding, not a
defect.** CHAL-004 rendered SATISFIED via PROPERTY_INHERITED from
run-mw8fkl0b: the parentRunId-linked CHAIN-STATE inheritance (same
spec digest, ancestor's persisted state satisfied, criteria pass at
this base) carries forward the ancestor's recorded verdict without
consulting oracle identity. That verdict was established under the
PRE-GATE rules - the very era when synthesis paired drifted oracles
silently. The ruling's letter governs synthesis (pairing red and
green evidence) and the chain-state inheritance is not synthesis -
it trusts a recorded verdict, digest-bound to an unchanged
contract. Whether a verdict established under pre-gate rules
constitutes "justified knowledge" for chain-state purposes is the
operator's epistemics call, the natural successor to the question
this ruling answered. RECORDED, NOT TAKEN: gating the chain-state
inheritance on oracle identity (or re-verifying inherited
satisfactions against drifted oracles) is a design decision with
real cost - it would demote every inherited satisfaction whose
ancestor predates the gate.

Also shipped this cycle: the challenge engine's crash-left worktree
pre-clean (the review's F3, hit for real - a hard-interrupted run
wedged the fixture permanently, exit 2 in 174ms on every retry;
run-mwhjsesr's CHAL-004 unsatisfied verdict was the crash leftover,
not the machinery; fixed red-first, 12/12 with, 2 failed without).

The honest ledger state across the ruling's own specs: all three
oracle-identity specs tree-satisfied, their cross-run synthesis
candidates judged and (so far) rejected by the gate, their pass-at-
base properties rescued by chain-state inheritance from pre-gate
ancestors. The system now has TWO distinct satisfied-channels with
different epistemic contracts - synthesis (gated on oracle
identity) and inheritance (gated on spec digest + recorded state) -
and the difference is now visible in events for the operator to
rule on.
