# adversarial review: oracle-relative-paths / run run-mwv7a7yc-c4972598

The defect: the oracle-identity gate (specs/oracle-identity.yaml and its
two companions, shipped 2026-11-14) had never admitted a real oracle.
It resolved a `pnpm --filter <pkg> ... <file>` criterion's oracle file
to an ABSOLUTE path, so git could not read it at a revision:
referencedOracleDiff answered held-fail-closed, the flip went to
counterfactual replay, and the replay failed on the same absolute path.
383 criteria in this repository use that shape. Census: zero evidence
records with a resolved oracle snapshot across every apply run on disk.

CORRECTION of earlier review logs: the oracle-identity and
inheritance-identity logs attribute their apply-run indeterminates to
"their own oracles were edited between halves". That was wrong. The
cause is this defect. Those properties were tree-satisfied through
verify, which requires no red.

Why the oracles stayed green for ten days: every oracle-identity
fixture used a bare `node <relative script>` criterion or a hand-built
map of relative package directories. Nothing exercised the real
resolver together with the command shape the repository actually uses.

What shipped (specs/oracle-relative-paths.yaml):

- ORP-001: package directories resolve relative to the root
  (packages/repo/src/oracle-scope.ts); oracleFilesRelativeTo makes an
  absolute path relative again, and oracleSnapshotAt reads through it.
- ORP-002: referencedOracleDiff answers untouched or drifted by
  repository-relative path instead of held-fail-closed; the replay of a
  pnpm --filter criterion answers red.
- ORP-003: the replay worktree is prepared with the shared helper; a
  failed preparation is unavailable, never red.
- ORP-004: the leftover debug console.log in the chain gate is gone.

Evidence: in a fresh process, verify run v-mwv7hqhc-7e2a22fa records
the ledger's first resolved oracle snapshots for the dominant shape:

    ORP-001-A  packages/repo/src/oracle-relative-paths.test.ts       sha256:c66b5099...
    ORP-002-A  packages/runtime/src/oracle-replay-prepared.test.ts   sha256:ee3499b7...

Run history, disclosed:

- Spec and two oracles committed (c0ca557): repo oracle 4 failed, 2
  controls passed; runtime oracle 6 failed - each on the diagnosed
  assertion.
- First rehearsal (`spc agent dry-run --gates build`) FAILED: my block
  replacement carried a closing brace its anchor did not, a syntax
  error in oracle-replay.ts. Caught before submission. The rehearsal
  prints only counts, so I applied the same operations to a throwaway
  worktree to see the error, corrected the operation, and rehearsed
  again: build clean, all four criteria pass.
- Same throwaway worktree: new oracles 6/6 and 6/6; regression
  oracle-identity 22/22, oracle-identity-wiring 2/2, oracle-replay 4/4,
  chain-memory 13/13, inheritance-identity 3/3. Worktree removed.
- Run run-mwv7a7yc (plan-20261124-004): 16 operations, 3 files. Red
  4/4, green 4/4 ("6 passed"). Properties INDETERMINATE in this run's
  ledger, for a reason that is structural: the applying process was
  started from the pre-fix build and judged its own sweep with the old
  code in memory - even its green halves record oracleClassification
  "unresolved". A process cannot use the repaired gate to validate its
  own repair. A fresh `spc verify` is the evidence: satisfied, 13 s.

Adversarial pass (read-only, on the whole delta): PUSH. No F1 or F2.
Confirmed sound: all four consumers of the changed resolver feed only
the classifier and oracleSnapshotAt; the verifier's separate absolute
resolver is read only by the scope-digest code; a path outside the root
becomes ../.. and git rejects it; referencedOracleDiff decides
identical, changed, absent-at-one-revision and glob-membership cases
correctly; bare node, node --test and quoted-glob shapes are unchanged;
the replay worktree is removed on every return path.

RECORDED NOT TAKEN (F3, backlog - the first two matter in practice):

1. A replay red is not gated on the preparation mode. In mode "none" or
   "linked" (a flat repository), a missing dependency prints "Cannot
   find module", records contradicts, and the replay answers red. This
   repository always prepares in "installed" mode and is not exposed.
   It is the replay clause of the 2026-11-23 worktree consensus, whose
   guardrails are an operator choice. Fix: carry the mode into the
   result and the COUNTERFACTUAL_REPLAY payload; in none/linked a red
   with failureShape suite-did-not-run is unavailable.
2. One worktree, install and build per drifting criterion, serially.
   Criteria that share an oracle file each replay it; replays used to
   exit in 0.3 s and now cost an install and a build each. Fix: memoize
   by command and file list within a run.
3. The replay branch spc/<spec>/replay-* is never deleted
   (removeWorktree ignores git's exit). Fix: delete the branch in the
   same finally. Ten exist locally.
4. `prepared.detail ?? ...` prints "preparation failed ()" when detail
   is an empty string. Fix: `||`.
5. A dead import of the verifier's workspacePackageDirs in
   chain-memory.ts:6.
6. Pre-existing: the replay never expands globs before overlaying, and
   its write follows a symlink tracked at the oracle path.

ORACLE GAPS recorded: no apply-level case yet shows a pnpm --filter
in-run flip with an untouched oracle ending satisfied with no replay
event - the run that shipped the fix ran the old code. held-fail-closed
for a file absent at one revision, glob-membership drift, and the
`overlaid` list are untested.

EFFECT GOING FORWARD: an in-run flip for a pnpm --filter criterion
establishes on its own evidence when the oracle file is unchanged
between the halves; cross-run synthesis compares real oracle digests,
so a criterion whose test file changed since its red was recorded is
rejected as drifted rather than silently paired.
