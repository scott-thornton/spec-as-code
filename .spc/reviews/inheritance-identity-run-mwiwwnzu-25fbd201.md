# adversarial review: inheritance-identity / runs run-mwirrnfp, run-mwiwfyu0, run-mwiwsdwp, run-mwiwwnzu

The operator's 2026-11-16 ruling, implemented: chain-state inheritance
rests on ADMISSIBLE ESTABLISHMENT, never a persisted label. The
consensus process: two reviewer positions split (distinct-contract vs
gate); Codex tie-broke for gating with the establishment-validation
refinement (the ancestor-vs-current comparison misses the original
invalid transition - the edge to validate is the ESTABLISHING
EVIDENCE); the operator authorized. Decision record
.spc/reviews/inheritance-identity-decision.md.

The gate (apply.ts, the chainedStates walk): before promoting an
indeterminate property to satisfied, every discriminating COMMAND
criterion of the property must (1) carry a gate-established flip
(inheritedFlips) and (2) TRANSFER - the establishing run's
result-revision oracle must match the current base-revision oracle
(oracleSnapshotAt both, compareOracleSnapshots; matched/unreferenced
pass, drifted rejects with 'establishing oracle drifted from
current', unresolved fails closed). Any blocking criterion appends
PROPERTY_INHERITANCE_REJECTED (propertyId, priorRunId, criterionId,
reason, detail) and the property stays indeterminate - the historical
verdict retained, immutable, inspectable. Non-command and
non-discriminating criteria never block (no attribution claim).

Oracle: 3/3 - the control inherits (admissible establishment +
matched transfer stays satisfied); the pre-gate label is refused
(the CHAL-004 shape reproduced: a hand-satisfied state over drifted
evidence cannot promote); the post-establishment drift is refused
(the establishment does not transfer). 26/26 regressions (apply,
chain-memory) - the existing chain-inheritance tests (clean
establishments) pass through the gate undisturbed, the LIST-001
semantics preserved.

The ledger is honest about its own construction: all three
inheritance-identity criteria render indeterminate in apply runs
(the oracle file was edited between the halves - the gate rejects
the pairing, exactly as ruled) while the stage-6 verify satisfies
them (tree-green). The machinery now has ONE policy for both
satisfied-channels.

Run history, disclosed: run-mwirrnfp failed (the executor window
expired before my answer landed - the harness retired the request;
nothing was applied, the run recorded nothing dishonest);
run-mwiwfyu0 landed the gate, the sweep stayed red on three
test-side bugs of mine (the transfer fixture satisfied via
SYNTHESIS v1+v1 matched halves - the fixture now drops the
establishing run's evidence file so only the label can promote,
which is the path this spec guards; the assertion aligned; the
compareOracleSnapshots import - it lives in runtime/oracle-identity,
not @spc/repo - the TS2305 the build caught). run-mwiwsdwp recorded
the green halves; run-mwiwwnzu materialized (still indeterminate -
the gate rejecting its own spec's pairing, the consistent pattern
across all four oracle-identity specs now).

RECORDED NOT TAKEN: the transfer check for the SYNTHESIS channel
(deliberately out of scope per the spec - a matched v1+v1 synthesis
satisfies even when today runs v2; extending establishing-vs-current
to synthesis is the successor question); reconstructability audit of
the real ledger (the fixture proves the mechanism; the blast-radius
survey of pre-gate ancestors is queued); PROPERTY_INHERITANCE
events predate the gate and are unaffected (their establishments
are re-judged only when a NEW run would rely on them).
