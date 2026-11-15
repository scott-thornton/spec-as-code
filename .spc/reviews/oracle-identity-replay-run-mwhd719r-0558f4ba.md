# adversarial review: oracle-identity-replay (slice 3) / runs run-mwhc1ly8, run-mwhd2bgk, run-mwhd719r

The ruling's third slice, implemented: in-run oracle drift demands
same-oracle counterfactual replay. The engine cuts an isolated
worktree at the run's BASE revision (startPoint - the oracle caught
my first version cutting at HEAD, which read green->green on the
rectification shape: the exact false refusal), overlays the FINAL
oracle file contents, executes the criterion through the frozen
machinery, and classifies: red -> counterfactualFlip ESTABLISHED
(the implementation change is what the criterion detected); green ->
indeterminate (the oracle change produced the flip - the weakened-
oracle counterexample, refused); unavailable -> indeterminate, named.
Creation-time oracle snapshots now ride every command-criterion
evidence payload (OIR-003: the referenced files' digests at the
evaluated revision - recorded, never reconstructed; command-only and
unsupported classifications record their marker). The classifier,
snapshot, and workspace machinery moved to @spc/repo/src/
oracle-scope.ts - one implementation shared by the runtime's
gate/replay and the verifier's evidence recording, no cycles; the
runtime module re-exports for import stability.

Oracle: 4/4 - the rectification shape (fix impl AND correct the
oracle) establishes via replay red; the weakened-oracle shape
(change ONLY the instrument) renders indeterminate; snapshots
recorded with real digests. 53/53 across the six-suite regression.

The gate judged the replay spec's own history (run-mwhd719r):
synthesis rejected - "(classification failed closed)" - the red half
(run-mwhc1ly8, at the pre-build-fix tree) predates the buildable
classifier path, so the oracle snapshot could not resolve at that
revision. The spec is tree-satisfied (stage-6 verify exit 0, all
three) and ledger-indeterminate until a fresh in-run flip - the
same honest state the ruling prescribed, now applied to all three of
its own implementation slices. The ruling's machinery has judged
every piece of its own construction by the rules it lays down for
everything else.

RECORDED NOT TAKEN: the replay fires only on in-run drift of
discriminating COMMAND criteria (file criteria and unreferenced
commands pay nothing - by design); replay cost is one worktree +
one criterion execution per drifted criterion, bounded by the run;
transitive-import closure remains the long-term identity scope.
Build-config lesson recorded: tsconfig.build.json is the authority
(the plain typecheck pass missed the shim's lost type imports - the
green-half run caught it, as designed).
