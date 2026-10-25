# Preflight fast-path: measured and declined

**Date:** 2026-10-25 · **Decision:** P2 (cached preflight environment)
not implemented - the measurement does not support the mechanism.

## The proposal's premise

The operator skips the preflight advisory under time pressure; the
proposed fix was to make it cheap by caching the prepared dependency
environment, on the stated premise that the offline install dominates
(~60-90s claimed).

## The measurement

Fresh detached worktree at HEAD, warm pnpm store, repeated once for
stability:

| Step | Wall time |
|---|---|
| `pnpm install --frozen-lockfile --offline` (cold worktree) | **0.37s** |
| `pnpm build` (cold) | 7.8s |
| `pnpm build` (no-change, incremental) | 3.9s |
| `pnpm build` (one-file change - the realistic preflight shape) | 3.8s |
| `git reset --hard && git clean -fd` (the cache's per-reuse reset) | 0.06s |

## Why the cache is declined

The premise was stale data: the 60-90s figure came from the first
install before the pnpm store was warm. With a warm store the offline
install is sub-second - there is nothing to cache. The cost that
remains is the build (7.8s cold, ~3.8s incremental), and a warm-base
worktree cache would save roughly 4 seconds of a preflight whose
dominant remaining cost is criteria execution (test suites, tens of
seconds), while reopening exactly the risk the external review flagged
for it: retained generated artifacts producing a false-green rehearsal.
Trading a real risk class for ~4 seconds fails the value test.

The reflection's behavioral finding stands - the advisory was skipped
under pressure - but the fix is not cost reduction; the preflight is
already cheap. The honest reading is that the skip was impatience, not
economics, and the remedy already shipped: the compose-then-submit
discipline, and the burned runs that priced it.

Provenance: measured live on the development workstation, 2026-10-25;
`scripts/board-flake-capture.mjs` conventions for machine-context
correlation were not needed (the spread is 20x, not marginal).
