# RFC: compose off the clock, submit against the successor

**Status:** draft for review - not a spec, no implementation authorized
by this document · **Date:** 2026-10-25 · **Origin:** the
provider-instability field report (docs/field-report-2026-10-24-provider-instability.md),
Finding 3; external review 2026-10-24

## Problem

The harness request window (900s default) couples two clocks that have
no necessary relationship: premise freshness - when an answer is
accepted, the request's premises must still match the tree - and
operator residency - under the current design, the answering agent must
be resident for the whole window. Executor answers assembled through
rehearsal routinely exceed 15 minutes, so dispatch → compose → submit
expires structurally, not occasionally. Under provider instability it
compounds (dead windows plus expirations); the field report records one
sacrificed run and several burned windows to this class.

The guarantee to preserve: an accepted answer's premises still match
reality when it is consumed. The demand to drop: continuous presence
while composing.

## Current lifecycle (verified in packages/llm-harness)

Pending request (role, key, schema, system, prompt, createdAt) →
15-minute window → answer arrives → validated against the request's
authoritative schema → consumed. Expired requests are archived to
`stale/` and must never be answered later - the stale sweep exists
precisely because a reconstructed session answering a dead request is
answering stale premises. There is no draft identity and no
successor-matching contract today.

## Proposal

Introduce transferability of a DRAFT between request identities, under
a strict equivalence contract. An expired request stays expired; the
draft is reusable, the old request is not resurrected.

### Semantic request equivalence

A draft composed against request N may be adopted by successor request
N+1 only when ALL of:

- canonical task payload digest matches (role + key + the request's
  canonicalized task payload - NOT raw rendered prompt equality, which
  is polluted by incidental request ids and generated banner text);
- schema identity matches (schemaName + schema digest);
- repository base revision matches the successor's payload;
- declared write scope matches;
- applicable policy context (config digest) matches.

Any mismatch: the draft is ineligible; the successor gets a fresh
dispatch. Equivalence is evaluated mechanically from recorded fields,
never inferred.

### Atomic adoption state machine

```
Drafted ──▶ Eligible-for-successor ──▶ Revalidated ──▶ Claimed ──▶ Consumed
   │              (equivalence holds)    (schema re-check)  (live request adopts)
   └─ any failure at any step: draft voided, never partially adopted
```

Adoption is atomic: the store either moves the draft to the live
request's answer slot with the successor's identity stamped, or leaves
everything untouched. Expiry during adoption must leave the draft
voided (no half-state), and the expired request dead.

### Storage

`.spc/harness/drafts/<id>.json` carrying: the composed value, the
equivalence tuple it was composed against, the composition timestamp,
and the state. Drafts are never evidence, never requests; they are
invisible to `spc agent list` except as an explicit `drafts:` count.

## Adversarial test list (the spec's oracle, when written)

1. Successor with a different task payload: draft ineligible.
2. Successor with a changed schema: ineligible.
3. Successor dispatched from a different base revision: ineligible.
4. Successor with a narrowed write scope: ineligible.
5. Config digest drift between composition and adoption: ineligible.
6. Competing consumers: two live requests both eligible - exactly one
   claims; the loser sees a fresh dispatch.
7. Expiry racing adoption: draft voided, no partial state, expired
   request stays dead.
8. An expired request is never resurrected by draft adoption (the
   stale-sweep guarantee is untouched).
9. Replayed adoption of an already-consumed draft: refused.
10. The composed-against tuple is recorded in the answer's lineage
    (provenance: the answer says which premises it was composed
    against, and that they matched at adoption).

## Threat-model notes

- The draft file is attacker-writable like everything else under
  `.spc/`; it confers no authority the answer queue does not already
  have. The equivalence tuple is the integrity mechanism - a tampered
  draft fails equivalence or schema validation exactly as a tampered
  answer does.
- Collusion concern (from the review of the anchoring work): a draft
  authored against stale premises and adopted despite drift is the
  primary risk; the base-revision and config-digest tuple members
  exist for this, and staging's existing base-digest check still
  governs at apply.

## Open questions for review

1. Should drafts expire (age cap) independent of adoption - e.g. 24h -
   to bound staleness of unclaimed compositions?
2. Should `spc agent respond` gain `--from-draft <id>` explicitly, or
   should adoption be automatic when the successor dispatches and a
   matching draft exists (auto-claim)? Explicit is slower but legible;
   automatic maximizes the availability win. Proposal: explicit in v1,
   automatic only if the explicit flow proves too slow in the field.
3. Does the planner role need this, or executors only? The field
   incidents were executor-composition; planner answers are small and
   fast. Proposal: executors only in v1.

## What this RFC deliberately does not do

No answer editing after adoption, no multi-request broadcast, no
cross-repository transfer, no change to window durations themselves.
The stale sweep, the fail-empty task records, and the continuation
machinery are untouched - they held during the incident and stay.
