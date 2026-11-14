# Decision record: oracle identity in flip attribution (operator ruling, 2026-11-14)

The epistemics question (oracle bytes vs criterion digest in chain-memory
synthesis) was put to two independent reviewers; they split (disclosure-note
vs gate-when-differ). The operator ruled. This record is the implementation
contract - build from this, not from summaries.

## The ruling

**Cross-run synthesis**: gate. When chain-memory pairs a red half (run A)
with a green half (run B) and the oracle file bytes differ between the two
observations' evaluation revisions, the synthesis is REJECTED - the
criterion renders indeterminate, a fresh in-run flip is required. Ground:
the flip is the system's core attribution claim; with oracle drift, two
independent variables changed (implementation AND instrument) and the
transition cannot be attributed. "If provenance changes whether a
conclusion is justified, provenance cannot be merely descriptive metadata."

**In-run flips with oracle drift**: same-oracle COUNTERFACTUAL REPLAY, not
automatic acceptance and not automatic rejection. A recorded changeset
EXPLAINS the transition but does not VALIDATE the measurement (the
weakened-oracle counterexample). When in-run oracle fingerprints differ
between the red half (base revision) and the final sweep (result
revision): replay the FINAL oracle snapshot against the BASE
implementation in an isolated worktree; the flip is established only if
the same-oracle comparison yields red -> green. If replay yields green ->
green, or replay is impossible: indeterminate. "More information should
enable a stronger verification procedure, not a weaker acceptance rule."

## The policy table

| Scenario                     | Policy                                    |
| ---------------------------- | ----------------------------------------- |
| Cross-run, oracle unchanged  | Synthesize                                |
| Cross-run, oracle drift      | Reject synthesis                          |
| Cross-run, oracle unresolved | Reject synthesis                          |
| In-run, oracle unchanged     | Normal red -> green                       |
| In-run, oracle drift         | Same-oracle counterfactual replay         |
| In-run, replay red -> green  | Accept with replay provenance             |
| In-run, replay green -> green| Indeterminate                             |
| In-run, replay unavailable   | Indeterminate                             |

## Extraction classification (fail-closed discipline)

| Classification | Behaviour                                   |
| -------------- | ------------------------------------------- |
| referenced     | Resolve and fingerprint referenced files    |
| unreferenced   | Positively established command-only         |
| unsupported    | Fail closed                                 |
| unresolved     | Fail closed                                 |
| drifted        | Reject synthesis (cross-run) / replay (in-run) |

Empty extraction NEVER implicitly means unreferenced - parser limitations
must not become false confidence. `pnpm -r`-style commands must be
POSITIVELY classified command-only, never defaulted there. The extractor
parses compound commands segment-wise and reuses workspacePackageDirs.
The classification audit across every criterion command in specs/ is a
deliverable of implementation (the referenced/unreferenced/unsupported
distribution, measured before enforcement).

## Implementation requirements

1. Oracle fingerprints recorded at evidence creation (OracleSnapshot:
   criterion definition digest, evaluated revision, files[{path,
   contentDigest}]); historical evidence reconstructed via the hardened
   git adapter at the EVALUATION revision (not blindly the run base).
2. Comparison atomic: one unresolved reference rejects the pairing.
3. Three provenance kinds, never flattened: synthesizedFlip (cross-run),
   inRunFlip (same-run, unchanged oracle), counterfactualFlip (replay).
4. Rejected synthesis candidates PRESERVED (runA -X-> runB, reason
   oracle_drift, the changed paths, both revisions) and rendered as
   "Synthesis rejected: oracle drift" - historical evidence immutable,
   inspectable, non-establishing.
5. The historical demotion is predicted IN THE SPEC: the existing
   synthesized flips that become rejected candidates (CHAL-004-A's
   run-mw81uztk -> run-mw86ka7e crosses an oracle edit), the criteria
   expected satisfied -> indeterminate, and the fresh-evidence
   restoration path. A regression fixture uses the ACTUAL CHAL-004-A
   history, not a synthetic example. The first verification after
   implementation produces an anticipated diff.
6. Replay machinery: isolated worktree at the base revision, final
   oracle snapshot overlaid, criterion through the frozen executor
   (admission inherited); structurally the challenge engine's move.
7. Transitive imports: out of scope for the first patch; the snapshot
   schema must evolve toward oracle closure (instrument, not subject);
   identity scope declared wherever fingerprints are claimed.

## Spec goal text (verbatim from the ruling)

> If provenance changes whether a conclusion is justified, provenance
> cannot be merely descriptive metadata.

> A discriminating verification must compare the same measurement
> instrument against different implementation states. A recorded
> changeset provides attribution context but does not, by itself,
> establish measurement equivalence.

Chain-memory exists to preserve justified knowledge across runs, not to
maximize reuse of historical outcomes. A trustworthy system distinguishes
what happened from what it can justify concluding about what happened.
