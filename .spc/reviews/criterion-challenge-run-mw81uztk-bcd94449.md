criterion-challenge / run run-mw81uztk (5th cycle: stale-baseline cancel -> digest-change re-plan -> plan-target
omission cancel+re-plan -> satisfied-6/7 with CHAL-004 red on report
shape -> rectified). The system detected a regression in its own ability
to detect regressions: the inaugural challenge reconstructs the archived
skew-carveout defect (728f805 -> 3924025) and comes back DISCRIMINATING
with the TS4104 diagnostic attributed in the report and provenance pinned.

Local validation caught (all fixed in-tree before the final cycle):
- The signature-surfacing question: every build-prefixed criterion
  redirects stdout to /dev/null and tsc diagnostics ride stdout - the
  detection surface is the PIPELINE (cold prepare + criterion), amended
  into the spec pre-commit.
- The true diagnostic is TS4104 (not TS2345 - quoted from incident
  memory, wrong); corrected in fixture/oracle/spec (protected-path
  corrections, committed pre-answer).
- File criteria carry structured payloads (no ENOENT text): output
  extraction generalized; the delete-fact fixture's signature is the
  serialized observed state.
- Fixture patch ops are anchor-based with APPLY-TIME baseDigest
  binding (replayable across revisions; anchor gone = not applicable =
  inconclusive - the honest rot answer).
- findSpecSource returns SOURCE TEXT not a path (local path resolver).
- The report now prints the signature token + the matching pipeline
  line (the record carries expectedSignature + signatureLine).

Process notes: three run cycles burned to my own plan-authoring errors
(stale baseline after corrections commit; runtime/src/index.ts omitted
from declared targets) - the write-scope guard caught each. The
challenge's own criteria execution rode host admission throughout
(CHAL-C01 by construction).
