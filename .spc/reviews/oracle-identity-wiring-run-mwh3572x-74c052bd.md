# adversarial review: oracle-identity-wiring (slice 2) / runs run-mwh1kget, run-mwh3102a, run-mwh3572x

The gate governs real synthesis (specs/oracle-identity-wiring; the
operator's ruling, slice 2). computeChainFlipMemory now gates every
candidate: classify, snapshot at BOTH halves' evaluation revisions,
compare, evaluate - matched/unreferenced establish; drifted/
unresolved/unsupported REJECT with a SYNTHESIS_REJECTED event (both
run ids, reason, paths, revisions, rendered detail). In-run flips
join via the current run's own revisions. The wiring oracle: stable
candidate synthesizes, drifted candidate rejected indeterminate with
the event - both green.

The run history is the finding: FIVE defects in my own wiring, each
caught by the oracle (95df489): the state.json field-name mismatch
(baseRevision/resultRevision vs .base/.result - the entire unresolved
class); in-run flips routed through the ancestor map (would have
rejected every legitimate in-run flip repo-wide); the revision walk
relying on parentRunId (never set by library-level applies); the
fixture's red cycles accidentally fixing the impl (every cycle an
in-run flip; no cross-run candidate ever existed) plus applyPlan's
latest-plan fallback silently applying the wrong spec's plan; and the
SYNTHESIS_REJECTED event type unregistered in the schema. Ghost runs
(aborted applies leaving events without metadata) excluded from
history searches.

THE GATE JUDGED ITS OWN HISTORY (run-mwh3572x): the wiring oracle's
red half was observed at a revision where the oracle file DID NOT
EXIST - no oracle identity to compare - unresolved, rejected, both
criteria indeterminate in the ledger. The spec is tree-satisfied
(stage-6 verify green: verify sweeps execute, they do not synthesize)
and ledger-indeterminate until a fresh in-run flip - the exact state
the ruling prescribed for CHAL-004-A, applied to the ruling's own
implementation. CI is unaffected: spc verify --all executes criteria
(the gate fires only in apply-run synthesis), so the demotion
surface is future APPLY runs of specs whose oracles were edited
between halves - the predicted list stands (criterion-challenge,
evidence-impact-report, reproduce-verification candidates).

RECORDED NOT TAKEN: slice 3 (the same-oracle counterfactual replay
engine + creation-time OracleSnapshot recording) is the re-establishment
mechanism for demoted candidates - the next slice; the replay
reuses the challenge engine's worktree discipline per the decision
record. The command-cache spurious-reuse finding (4 executed/408
reused under starvation) is separately recorded in the spc-verify
timeout commit.
