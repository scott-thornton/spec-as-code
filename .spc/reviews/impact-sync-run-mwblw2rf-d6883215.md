# adversarial review: impact sync + ergonomics flake / run run-mwblw2rf

Two backlog items closed autonomously (operator: "do what you can").

Impact sync (the skip-engine confirmation's recorded one-liners):
.pnpmfile.cjs joins impact's WORKSPACE_DEFINING (red-first - a
committed pnpmfile at base, a hooks-change diff intersects union
scopes IMPD-001-E while the package scope stays disjoint; run
run-mwblw2rf all four satisfied), and the shadow check's dirPrefixes
gain the win32 separator normalization ported from verify.ts (posix
no-op, correctness port, NO local oracle possible on this platform -
disclosed). verify and impact now agree on every scope, both lists
identical, both normalizations identical.

Run-ergonomics flake: root-caused from the run ledger itself - "Test
timed out in 5000ms" (run-mwbjgpdv's second battery execution; first
green at <1s, siblings at 4s/2.6s in the same window). The session's
ORIGINAL false-red class, back for a visit: process-spawning tests
under load vs vitest's 5s default. Fix: scoped 60s timeouts matching
the 60s spawn budget. The bookkeeping run (run-mwbmafxg) renders
RE-001/002 indeterminate - a test-only commit passes at base, and the
spec's ancient flip halves do not synthesize (ancestor criteria
digests predate current definitions). Disclosed rather than chased:
the fix is behavior-neutral, locally green, and CI validates on push.

Also demonstrated twice today (recorded, guard backloged): plan-id
collisions across concurrent planning sessions - plan-20261110-007
and plan-20261111-005 were each reused by a second session, once
producing a harmless duplicate verify-only run. A uniqueness guard
(mint-and-check or uuid suffixes) is the fix when wanted.
