# adversarial review: evidence-impact-report / runs run-mw8paqk8, run-mw8pmuk4, run-mw8q4nhg, run-mw8r05w6, run-mw8ra9tp

Order 2: spc impact <baseRev>..<headRev> - a read-only projection of
which recorded observations a revision range may touch, reusing the
trusted derivations (git diff -z --no-renames fail-closed,
parseFilterScope's declared scopes, exact path membership), text +
--json, no criterion execution, no writes.

Pass 1 (full delta): NEEDS-RECTIFICATION - three F1 false-disjoint
channels, all inherited from the shared derivation (verify's skip
engine has them too) but hard-rule violations under this spec's
letter: (1) a changed TRACKED dist/node_modules artifact inside a
scope directory is invisible to the filtered file set; (2)
workspace-union scopes (pnpm -r) are blind to the workspace-defining
root config that defines their closure - triggerable by live specs;
(3) a declared-but-unresolvable package or workspace dep silently
shrinks the scope - exactly IMP-002's 'undeclared dependencies'
enumeration. Plus F2s: three-dot range trap, evidence-selection
precedence/supersede blindness, silent uncompilable-spec gaps,
suite-registry-failure mislabeling, file-path normalization.

Rectified (run-mw8r05w6, 4 red oracles + scope amendment for the
one-word verifier export): shadowed-path check (changed inside a
scope dir but outside the declared file set -> undetermined);
workspace-defining files inside union scopes only; completeness walk
over declared packages AND the withDeps workspace: closure (verified
field-for-field against the trusted derivation - pnpm excludes
peerDependencies from ... closures by design, so not walking them is
correct); three-dot rejected by name; apply-dominant evidence
selection with supersede skip; uncompilable specs named on stderr;
registry-failure reason distinct from unresolvable-ref; path
normalization both sides.

Pass 2 (confirmation on the rectification delta): SHIP-QUALITY -
every fix confirmed at file:line, the negative control holds
(package-scoped criteria unaffected by root config), pnpm closure
semantics verified against upstream docs. RECORDED NOT TAKEN (sub-bar):
.pnpmfile.cjs absent from WORKSPACE_DEFINING (conservative direction,
one line, rides the next engine-touching cycle); optionalDependencies
closure semantics undocumented by pnpm and shared with the trusted
derivation (pre-existing, not a regression). Backlog from pass 1
standing: the shared derivation's own variants of the three channels
(verify's skip engine - its own decision, its own spec); F2-9, the
synthesized-flip gate covers criterion definitions but not oracle
bytes (disclosed pairing here; mechanism would bless unsound pairings
silently - revisit if oracle-edit rectifications become routine).

Run history, honestly lumpy: run-mw8paqk8 (IMP-001/003/C01 in-run
flips; IMP-002 red on TWO oracle authoring bugs of mine - shell-join
git arg, wrong range premise - fixed and disclosed); run-mw8pmuk4
(recorded IMP-002's green half; indeterminate - correct per
chain-memory's letter, both halves must be prior: a post-run oracle
rectification costs one trailing run); run-mw8q4nhg (all four
satisfied via red@mw8paqk8 -> green@mw8pmuk4 synthesis - the memory's
first routine consumer); run-mw8r05w6 (rectification landed; its own
red sweep broke on the v2 import preceding the verifier export, and
one more test-premise bug of mine - the workspace-config test's range
swallowed the preceding test's dist commit; disclosed); run-mw8ra9tp
(all four satisfied, flips synthesized ACROSS the amendment fork -
the fork-fix dividend in full: the mid-rectification scope amendment
cost nothing).

Proof: 11/11 oracles green; stage-6 verify exit 0 (100% reuse);
CI watched on the satisfaction commit.
