# adversarial review: oracle-identity (slice 1, decision layer) / runs run-mwgpc4nt, run-mwgprete, run-mwgpvmrz

The operator's 2026-11-14 ruling, slice 1: the pure decision layer +
snapshot machinery (specs/oracle-identity, decision record
.spc/reviews/oracle-identity-decision.md). Extraction five-way and
fail-closed; snapshots at evaluation revisions via the hardened git
adapter; the cross-run gate with rejected-candidate preservation; the
counterfactual decision layer; the pinned audit. The WIRING into
computeChainFlipMemory and the replay ENGINE are deliberately the
follow-on slice - the gate's semantics proven pure before they govern
real runs.

Pass 1 (full delta): NEEDS-RECTIFICATION on a letter-violation - two
OPEN DEFAULTS let unrecognized command tails reach unreferenced
('node --test', 'exec tsx/bash', script-defined tools; exec-node
failed OPEN on unresolvable filters where vitest failed closed), the
exact bucket the ruling forbids defaulting into; the audit pin did
not bound the unreferenced bucket; the rejected candidate dropped
both run ids. RECTIFIED (22/22): unreferenced is now POSITIVE only
(bare --filter with nothing executing; node -e/--eval/no-args; a
build tail - the pnpm -r build class from the ruling's table); every
other tail fails closed; exec-interpreter polarity uniform (any KNOWN
interpreter with a resolvable JS/TS script is referenced - the script
IS the oracle, the interpreter irrelevant; non-resolvable shapes
unsupported); FlipRejection carries redRunId/greenRunId rendered
'runA -X-> runB'; the audit pins discriminating.unreferenced === 0.

RECORDED NOT TAKEN (wiring-slice scope, per the reviewer): the
identity scope is rendered but not structured in FlipDecision;
criterionDigest never populated; OID-005's fixture is a faithful
replica (real command shape, real run ids, synthetic revisions) - the
ACTUAL run-mw81uztk->run-mw86ka7e demotion verifies when the gate
governs real synthesis; dist/ fingerprints degenerate to permanent
unresolved (SELF-001-A) - needs an honest special-case; binary
digests hash utf8-decoded stdout (collision-theoretic); audit walk
fragilities (folded scalars, comments); spec prose distribution
updated to the measured 6.

ALSO RECORDED (pre-existing, its own cycle): workspacePackageDirs
returns EMPTY on this repo - its minimal parser keeps the QUOTES in
'- "packages/*"' (pnpm-workspace.yaml), so every @spc/* filter is
unresolvable through it; resolveScopeDirs is silently starved here
too (the impact and DSV engines build their own maps from
packages/*/package.json in tests - production callers of
parseFilterScope-derived resolution on THIS repo get empty scopes
today).

Runs: run-mwgpc4nt (red - implementation landed against oracle bugs
of mine: collection-time snapshots, missing resolvable callback,
starved audit map), run-mwgprete (green halves), run-mwgpvmrz (all
five satisfied - noted with irony: this synthesis paired a red from
the pre-fix oracle with a green from the post-fix one, exactly the
drift class the wiring slice will gate). 22/22 after rectification;
stage-6 verify exit 0 (100% reuse).

Proof: CI watched on the satisfaction commit.
