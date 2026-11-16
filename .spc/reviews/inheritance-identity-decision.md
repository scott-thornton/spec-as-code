# Decision record: chain-state inheritance gated on oracle identity (operator-authorized, 2026-11-16)

Consensus process: two independent reviewer positions (distinct-contract
vs gate-inheritance) split on the crux; Codex (tertiary, tie-breaker)
sided with gating and REFUTED the distinct-contract position's three
core arguments while correcting the gate position's mechanism. The
operator authorized implementation of the synthesized consensus.

## The ruling (the consensus, verbatim in substance)

The same evidence requirements govern every route to current
satisfaction. One policy for both satisfied-channels: synthesis
(already gated) and chain-state inheritance (now gated).

1. THE ESTABLISHMENT, NOT THE LABEL: a persisted `satisfied` label
   alone is insufficient. Inheritance may promote a pass-at-base
   discriminating criterion only when an establishment ADMISSIBLE
   under the current attribution rules exists - the synthesis gate
   would establish it (an admissible red/green pairing, or an in-run
   flip the machinery itself earned, including counterfactual
   replay). Codex's refutation of the different-claim position: the
   weaker claim would require a separate status ("historically
   satisfied, establishment unverified"); using the same operational
   `satisfied` makes historical authority substitute for evidence -
   and a provenance note does not change the substitution.
2. THE TRANSFER CHECK: the ESTABLISHING oracle must match the
   CURRENT oracle (the establishing revision's vs the current base
   revision's). A token that drifted between the establishment and
   now does not transfer - the criterion that passed then is not
   the criterion that passes now. Codex's insufficiency finding
   against a naive ancestor-vs-current comparison: the ancestor's
   own green half may match today while the ORIGINAL transition
   crossed drift (O1->O2 synthesized, today still O2) - the edge to
   validate is the establishing evidence, not the final green.
3. REJECTIONS ARE PRESERVED: PROPERTY_INHERITANCE_REJECTED events
   carry the property, prior run, criterion, and reason - immutable,
   inspectable, non-establishing (the ruling's rejected-candidate
   discipline). Historical records unchanged; demotion means
   insufficient justification, never implementation failure.
4. NON-DISCRIMINATING CRITERIA AND NON-COMMAND CRITERIA INHERIT
   FREELY: they carry no attribution claim - the gate touches only
   discriminating command criteria rendered pass-at-base.
5. ELIGIBILITY IS RECORD-BASED, NEVER DATE-BASED: no grandfathering
   line. Pre-gate ancestors are admissible exactly when their
   establishing evidence reconstructs and passes the gate.
6. MIGRATION: the reconstructability audit measures the blast radius
   BEFORE enforcement ships; where reconstruction genuinely fails,
   accept the demotion and restore via fresh evidence; operator
   audit + supersede manage identified unsound records - as
   migration support, not substitute for enforcement (a one-time
   audit cannot govern future drift).

## Standing principles extended

> If provenance changes whether a conclusion is justified, provenance
> cannot be merely descriptive metadata. (the 2026-11-14 ruling)

> A channel that promotes a verdict may only rest on evidence the
> current attribution rules admit; history records what happened,
> and today's run decides what it may rely on. (this ruling)
