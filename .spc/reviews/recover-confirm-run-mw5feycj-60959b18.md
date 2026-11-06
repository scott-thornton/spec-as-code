# adversarial review: recover-confirm / runs run-mw5feycj + run-mw5fjykd

Read-only pass (RAM discipline). Verdict PASS with findings; CI green on
HEAD 3924025 discharges the in-run evidence failure (both criteria were
red from the pre-hotfix executor type error, before the oracle ran - the
feature landed via the run's commit b710551 + hotfix).

Findings: F1 minor - the no-confirm refusal detail lost its case
distinction (wedged-local vs foreign-host, host named) - FIXED
(reasons[] joined; both cases named again); F2 info - the loop now
SIGTERMs every alive worker before refusing instead of short-circuiting
(benign-to-better, noted against REC-002's letter); F3 medium - the
oracle's host-mismatch backstop vacated the wedged-worker discrimination
(host "fixture" never matches) - FIXED (real hostname; the liveness path
is now load-bearing) + added the confirmed-clean negative leg (all dead
+ confirm -> recovered, NO marker, "all verified stopped"); F4 info -
discharged by CI.

Exonerations: multi-worker collection (only wedged/foreign collected);
marker only when non-empty; lock-first never-overridable; CLI threading
backward-compatible; five-step flow and clearIntent order intact; no
readonly-assignment class in the diff.

Delivery note: the first run's criteria were red from the unrelated
type error yet the run committed the ops - the in-place model commits
the tree at finalize regardless of criterion outcome; the standalone
verify + CI arbitrated. Also: one cancellation went INCOMPLETE (darwin)
and the owner self-finalized via the AO-003 scheduler stop - the exact
machinery this spec's --confirm exists to complement.

Proof: oracle 3/3 (fresh build, tsbuildinfo deleted); spec verify exit 0
(REC-001/002 satisfied on HEAD).
