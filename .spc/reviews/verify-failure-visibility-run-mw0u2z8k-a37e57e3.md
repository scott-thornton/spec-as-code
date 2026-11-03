# adversarial review: verify-failure-visibility / run-mw0u2z8k-a37e57e3

Target: spec verify-failure-visibility (digest sha256:677007f7...), run
run-mw0u2z8k-a37e57e3, revision range 8ac5867..79595a5e
(packages/cli/src/commands/verify.ts).

## pass 1 — reviewer (subagent, adverse-review)

Findings (id / severity / class / property / citation):

- **F1 MAJOR** contract violation — the Unsatisfied block prints in
  `--format github` (guard `format !== "json"` includes github).
  outOfScope: "the github format (CI annotations already enumerate
  failures per spec)". verify.ts block guard; empirical: failing
  fixture `verify --all --format github` ends with the plain-text
  block. CI (spc-verify.yml) runs github format - every red log would
  carry it.
- **F2 MAJOR** green multi-spec json gains a never-before-printed
  `executions` array element (the print moved after the accounting
  push; pre-diff the entry was pushed but never reached stdout).
  VF-003 byte-identity; no requirement asks for it. No downstream
  consumer parses the array (grepped: skills, docs, workflows) - but
  the array turns heterogeneous for no contract reason.
- **F3 MINOR** zero-command failing runs print the block with no
  Executions line (the anchor the spec's letter names). Block is still
  terminal; oracle documents the presupposition. Accepted as-is.
- **F4 INFO** `--run`/`--bundle` modes have no block/array (letter:
  "single spec or --all"). Letter-compliant.
- **F5 INFO** the run's recorded VF-003 contradiction was a git-config
  flake in packages/repo git.test.ts (timeout, unrelated diff); full
  battery green at HEAD (55 files / 225 tests), standalone
  spc verify: VF-001/002/003 all satisfied, exit 0.
- **F6 INFO** exonerations: worst=1-without-block unreachable; cached
  specs can never hide failures (freshness requires all-satisfied);
  waived excluded; no empty-reason line reachable; green text and
  github output byte-identical.

## rectification — fixer (main agent)

F1: block guard narrowed `format !== "json"` -> `format === "text"`.
F2: the json executions push removed (text-only accounting line); the
terminal json print carries the spec reports and the failures array,
nothing else. Stale comment adjusted. Applied through the between-runs
patch leg (spc patch build --batch -> patch verify -> patch apply),
NOT direct edits.

Proof: spc verify specs/verify-failure-visibility.yaml (all satisfied,
exit 0) + full cli battery + github-format probe re-run clean.
Result recorded below after verification.

## result — proved by spc verify (not the fixer's word)

Rectification ops applied (spc patch build --batch -> verify -> apply,
provenance in .spc/patch-log.jsonl):
1. block guard `format !== "json"` -> `format === "text"` (F1)
2. json executions push removed; accounting line text-only (F2)
3. stale comment adjusted

Proof (2026-11-03):
- github-format failing fixture: exit 1, NO block (grep 0) - F1 closed
- text-format failing fixture: block terminal, correct shape
- json: keys [spec, runId, properties, followups, failures], no
  executions element - F2 closed
- cli battery: 55 files / 225 tests green
- spc verify specs/verify-failure-visibility.yaml: VF-001, VF-002,
  VF-003 all satisfied, exit 0

F3/F4 accepted as letter-compliant (recorded above). Sign-off: main
agent, after proof.
