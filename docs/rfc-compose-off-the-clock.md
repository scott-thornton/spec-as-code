# RFC: portable answer candidates - compose off the clock, submit against the successor

**Status:** v3, final - review gates resolved (persistent-state contract,
race-test references, executable crash invariant) · **Date:** 2026-10-25 · **Origin:** the provider-instability
field report (docs/field-report-2026-10-24-provider-instability.md),
Finding 3; external reviews 2026-10-24 and 2026-10-25

## Problem

The harness request window (900s default) couples two clocks that have
no necessary relationship: composition latency - how long the agent
needs to produce and rehearse a valid answer - and acceptance freshness
- whether the assumptions supporting that answer still hold when the
system accepts it. Executor answers assembled through rehearsal
routinely exceed the window, so dispatch → compose → submit expires
structurally. The field report records one sacrificed run and several
burned windows to this class. The system failed safely every time; the
cost was lost composition work.

The principle this RFC builds around:

> An expired request stays dead. A reusable computation is not a
> reusable authorization.

## The abstraction (v2's central change)

**Computation produces candidates; authority admits candidates.**

The new component is a portable answer artifact - an immutable
candidate carrying its composition provenance - NOT a second request
lifecycle. The existing harness keeps sole ownership of requests,
expiry, the stale sweep, consumption, and fail-empty behavior. A
candidate exists independently of any request; a live request admits
it (or refuses it) at submission time.

```
compose and rehearse (off the clock, any duration)
        |
        v
  immutable candidate + dependency fingerprint + provenance
        |
        v
  live request dispatched (the clock starts here)
        |
        v
  compare fingerprint + validate schema + atomic claim
        |
        v
  the EXISTING answer lifecycle (validate, consume, expire)
```

## The candidate artifact

`.spc/harness/candidates/<id>.json`, immutable once written:

- `value` - the composed answer;
- `composedAgainst` - the dependency fingerprint recorded at
  composition (task payload digest, schema digest, repository base
  revision, declared write scope, config digest), for **provenance
  only**;
- `composedAt`, `composedBy` - lineage.

Candidates are never evidence, never requests, and carry no authority.
Their security posture is **equivalence with the existing answer
queue** - the same trust boundary, the same attack surface, nothing
added: a tampered candidate fails fingerprint comparison or schema
validation exactly as a tampered answer does today. Hashes here are
comparison keys, not an integrity mechanism; the fingerprint that
matters is **derived from the authoritative live request records at
claim time**, never trusted from the candidate file.

## Claim: the acceptance boundary, defined

Claim is the single acceptance operation, and it is the boundary at
which freshness is established:

1. The store derives the live request's fingerprint **from the
   request's own records** (its payload, schema, base revision, scope,
   and the current config digest).
2. Window check: the request must be live. An expired request can
   never claim - the stale sweep's guarantee is untouched.
3. Fingerprint comparison: candidate's `composedAgainst` must equal the
   derived live fingerprint. Any mismatch **rejects the claim attempt
   and preserves the candidate** - it may match a different successor.
4. Schema validation of the candidate's value against the request's
   authoritative schema.
5. Atomic commit: the answer file is written to a temp name and
   renamed into `answered/<requestId>.json` (the store's existing
   single-answer-per-request slot) with both identities stamped
   (candidate id in the answer lineage, request id as the answer id).
   The rename is the commit; the candidate file is never mutated.

After a successful claim, the candidate is `Consumed` and the value is
an ordinary pending answer: the waiting provider process validates and
consumes it under the existing lifecycle. The claim-consumption gap is
bounded by the existing poll interval; the expiry race is covered by
step 2 plus the rule that the expiry sweep and claim serialize on the
same store (test 11).

Why this is no weaker than today: the current window checks liveness
only - it has never checked tree state, and neither does claim. Tree
drift is governed where it has always been governed, at apply, by
staging's base-digest enforcement and scope enforcement. Defense in
depth, unchanged.

## Persistent state

Three states, deliberately minimal: `Available → Claimed → Consumed`.
Eligibility is NOT a persisted state - it is a predicate evaluated
between one candidate and one live request at claim time. Nothing is
voided by a mismatch; nothing needs crash recovery beyond "an
unconsumed candidate is Available."

## Open questions - resolved per review (2026-10-25)

| Question | Decision |
|---|---|
| Candidate age cap | Yes, for garbage collection only (not a freshness guarantee) |
| Explicit vs automatic adoption | Explicit `--from-candidate <id>` in v1 |
| Role support | Executors only in v1 |
| Fingerprint mismatch | Reject the attempt; preserve the candidate |
| Adoption | Atomic claim against the live request |
| Provenance | Mandatory: composition and adoption identities in the answer lineage |

## Adversarial test list (the spec's oracle, when written)

1. Successor with a different task payload: claim rejected, candidate preserved.
2. Successor with a changed schema: rejected, preserved.
3. Successor dispatched from a different base revision: rejected, preserved.
4. Successor with a narrowed write scope: rejected, preserved.
5. Config digest drift between composition and claim: rejected, preserved.
6. Competing consumers: two live requests both fingerprint-match - exactly one claims.
7. Expiry racing claim (either order): no partial state; the expired request stays dead; an unclaimed candidate stays Available.
8. An expired request is never resurrected (stale-sweep guarantee untouched).
9. Re-claim of an already-consumed candidate: refused.
10. The admitted answer's lineage records both identities and the matching fingerprint.
11. Claim succeeds, expiry races consumption: the answer is either consumed coherently or the run fails empty honestly - never half-state.
12. Crash/restart at every persistence boundary: candidates are either fully written (Available) or absent; claims are atomic or nothing.
13. Dirty working tree between composition and claim: claim is unaffected (it never checked the tree); apply-time enforcement governs, exactly as for direct answers today.

## Non-goals

No answer editing after claim, no broadcast, no cross-repository
transfer, no window-duration changes, no planner support in v1, no
recovery of partially completed reasoning - only materialized
candidates survive. The reviewer's larger frame (resumable agents,
speculative execution, external executors, cross-provider composition)
is the direction this abstraction points; none of it is built by this
RFC, and the abstraction is chosen so as not to foreclose it.
