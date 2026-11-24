# adversarial review: verify-selection / runs run-mwv64yxv, run-mwv6aiwv, run-mwv6qg5k

The operator's ask: "spc verify takes too long. go figure out how to
verify 1 spec or N specs only." Finding: one spec already worked
(`spc verify specs/<id>.yaml`); bare `spc verify` runs every spec; N
specs were not supported. Shipped: `spc verify [selector...]`.

What shipped (specs/verify-selection.yaml): each selector resolves to an
existing regular file at that path, else specs/<selector>.yaml or .yml,
else the spec whose metadata.id equals the selector. Exactly the resolved
specs are verified, in order, each once. An unresolvable selector fails
the whole invocation before any criterion runs (exit 2,
SPEC_FILE_NOT_FOUND). Selectors cannot be combined with --run or
--bundle (exit 2, VERIFY_SELECTOR_CONFLICT). No selector keeps the
all-specs behavior; one selector keeps single-spec output.

Measured on this repository: one spec 10-11 s; two specs by id in one
command 8.5 s when freshness-cached.

Oracle: packages/cli/src/verify-selection.test.ts, 15 cases, whole-file
runs, no title filter. Red at base: 7 failed, 2 controls passed; after
the amendment: 6 failed, 9 passed. Green: 15 passed.

Run history, disclosed:

- run-mwv64yxv (plan-20261124-001): 8 patch ops applied; MY ERROR. The
  main.ts patch replaced the wrong second line - the action's `const
  vfmt` line sits between the two lines I targeted - so the CLI no
  longer typechecked and the run ended partially_satisfied. I had
  submitted with --no-preflight, skipping the dry-run the CLI advised.
- run-mwv6aiwv (plan-20261124-002): a one-op repair; red 7 failed, green
  9 passed. Indeterminate in the ledger - see the gate defect below.
- Adversarial pass 1 on that delta: no F1, two F2, five F3.
- Spec and oracle amended (7486361), then run-mwv6qg5k
  (plan-20261124-003): rehearsed first with `spc agent dry-run --gates
  build` (31 s, clean), 10 ops applied; red 6 failed, 9 passed; green
  15 passed. Indeterminate in the ledger - the same gate defect.
- Verify runs: all three properties satisfied; specs/verify-all-specs
  (VAS-001, VAS-002) still satisfied.

Adversarial pass 1 (fixes applied in run-mwv6qg5k):

- F2: existsSync accepts directories, so a selector naming a directory
  was taken as a file and errored instead of falling through to the stem
  and id lookups. Fixed: regular file only, at both lookups.
- F2: --bundle and --run returned before selection was resolved, so
  selectors were silently dropped. Fixed: the combination is refused.
- F3: two spec files sharing one id - the first sorted was taken
  silently. Fixed: an error naming both files.
- F3: deduplication keyed on the spelled path. Fixed: keyed on the real
  path.
- F3: the synopsis omitted json. Fixed.

Adversarial pass 2 (on the fix delta): PUSH. No F1 or F2. Confirmed by
reading: the conflict check precedes both modes; a dangling symlink
falls through; an unreadable file is SPEC_INVALID naming it; none of the
six new cases can pass vacuously, and each goes red if its fix is
removed; no path silently drops a selector.

RECORDED NOT TAKEN (F3, backlog):

- context.ts, isRegularFile: `throwIfNoEntry: false` suppresses only
  ENOENT; other stat errors (ELOOP on a symlink loop, EACCES through an
  unsearchable directory) escape raw. Fix: try/catch, return false.
- context.ts, realPathOf: case variants still verify twice on a
  case-insensitive volume. Fix: realpathSync.native in the same
  try/catch.
- context.ts, id scan: one dangling specs/*.yaml symlink throws in
  compileSpecFile and refuses every id lookup (pre-existing). Fix: skip
  entries that are not regular files.
- context.ts: an id selector compiles specs up to its match, and a miss
  compiles all of specs/ (110 here). Fix: build the id index once per
  invocation.
- verify.ts (pre-existing, outside this change): under
  --scoped-to-diff, skipIds is keyed on criterion id alone, so a skip for
  one selected spec skips the same-named criterion in the others. Fix:
  key on spec id plus criterion id.
- Oracle gap: the stem step is uncovered in isolation (every fixture's
  stem equals its id except zulu).

THE GATE DEFECT FOUND HERE (not from this change; next cycle):

The oracle-identity machinery (specs/oracle-identity*.yaml, shipped
2026-11-14) resolves a `pnpm --filter <pkg> ... <test file>` criterion's
oracle file to an ABSOLUTE path: both workspacePackageDirs helpers
(packages/repo/src/oracle-scope.ts:16,
packages/verifier/src/command-cache.ts:96) return root-joined directories
and classifySegment joins them (oracle-scope.ts:107, 115). git can never
read an absolute path at a revision, so oracleSnapshotAt fails closed
and every such criterion records oracleClassification "unresolved".
Census: across every apply run on disk there are ZERO evidence records
with a resolved oracle snapshot. The gate has operated in its fail-closed
mode for every real criterion since it landed; in-run flips fall through
to counterfactual replay, which fails the same way ("oracle file
<absolute path> unreadable at <revision>"), and the property renders
indeterminate.

Why the oracles stayed green: every oracle-identity fixture uses a plain
`node <relative script>` criterion. None exercises the pnpm --filter
shape that this repository's 383 package-manager criteria use.

CORRECTION of earlier review logs: the oracle-identity and
inheritance-identity logs attribute their apply-run indeterminates to
"their own oracles were edited between halves". That attribution is
wrong; the cause is this defect. Those properties are tree-satisfied
through verify, which requires no red; no apply run has established an
in-run flip for a pnpm --filter criterion since 2026-11-14.

NOTES FOR THE SKILL (owed):

- The executor answer requires commands, observations, evidenceCandidates
  and followups even when empty; the documented shape omitted them.
- Take the dry-run advice. `spc agent dry-run <id> --file <draft> --gates
  build` is a safe rehearsal (about 30 s). Never bare `--gates`: the root
  test script is `pnpm -r run test`, the full battery.
