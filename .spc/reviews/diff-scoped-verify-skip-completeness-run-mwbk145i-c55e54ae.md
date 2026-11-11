# adversarial review: skip-engine completeness / runs run-mwbex56f, run-mwbiqmsj, run-mwbjgpdv, run-mwbk145i

The backlog's live wire: verify's own --scoped-to-diff engine carried
the three false-disjoint channels impact's review found in the shared
derivation - and a SKIP is a criterion never executed, so an unproven
skip is vacuous-green territory. The banner's own letter is "proven
disjoint".

Pass 1 (the fix, prescribed by the impact review): the completeness
walk over declared packages and the withDeps workspace: closure;
WORKSPACE_DEFINING (pnpm-workspace.yaml, package.json, pnpm-lock.yaml,
.npmrc, .pnpmfile.cjs) gates union scopes; the filtered-file-set
shadow check; file-path normalization. Three channel oracles
(dist-artifact, workspace-config, declared ghost), fresh-fixture
factory with union + ghost-filter criteria.

Pass 2 (confirmation): NEEDS-RECTIFICATION - a transplant artifact:
the walk's continue statements landed inside the NESTED loops,
pruning the BFS instead of forcing evaluation, so an unresolvable
workspace DEPENDENCY (one level deeper than the declared ghost) still
permitted a skip on a silently shrunken closure - and verify and
impact disagreed about the same scope. Rectified with fail-closed
control flow (an incomplete flag breaks the BFS; one criterion-level
continue) mirroring impact.ts exactly, plus the closure-ghost oracle
row (criterion F, pkg-b declaring ghost-dep workspace:*), whose
poisoning of channels 2 and 3's exact-set pins demonstrated the F1
live. CONFIRMED CLEAN: guards only remove skips; normalization
correct on both platforms (notably MORE correct than impact.ts:153,
which lacks the sep conversion - recorded); the channel pins are
exact and non-vacuous (toEqual on the full ordered skip set).

RECORDED NOT TAKEN: sync .pnpmfile.cjs into impact.ts's
WORKSPACE_DEFINING and port the sep-normalization from verify.ts:456
into impact.ts:153 (two one-liners, impact-side, next
impact-touching cycle); the run-ergonomics 'quick --write' flake -
timing-sensitive under consecutive full-battery executions (first run
green, second red, standalone green; durations in run-mwbjgpdv) -
pre-existing, backloged, and a plan-shape note: battery-class criteria
double their exposure when one run sweeps them twice.

Run history: run-mwbex56f (engine fix landed; sweep stayed red on one
oracle fixture bug of mine - the channel-2 touch appended a stray
line corrupting the workspace yaml, pnpm failing for the wrong
reason; fixed + disclosed), run-mwbiqmsj (all four satisfied),
run-mwbjgpdv (closure-walk rectification; DSV-001..003 satisfied;
DSV-004 contradicted on the flaky second battery execution),
run-mwbk145i (all four satisfied, single battery execution green).
Also disclosed: a plan-file id collision (plan-20261110-007 reused
across two planning sessions) produced one duplicate RPDF
materialization run (harmless, verify-only) before the DSV plan
persisted as plan-20261111-001 - worth a uniqueness guard someday.

Proof: 9/9 oracles; stage-6 verify exit 0; CI watched on the
satisfaction commit.
