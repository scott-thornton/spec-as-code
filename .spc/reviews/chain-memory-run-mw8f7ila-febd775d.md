# adversarial review: chain-memory / runs run-mw8e91ek, run-mw8eh0db, run-mw8f7ila

Origin: the probe. After the operator challenged the blame narratives,
a throwaway spec on branch probe/digest-fork-repro (never merged)
reproduced the orphan with zero feature code: PROBE-B byte-identical,
flip recorded one run earlier, indeterminate passed_at_base
(run-mw8arnxy); PROBE-A indeterminate through its own unchanged
pre-amendment criterion. The defect: apply.ts walked parentRunId links
only, an amendment forks the digest, no parent exists, and every
pass-at-base criterion orphans.

Spec specs/chain-memory.yaml (24f6cb5e): lineage stays same-digest -
a chain is one contract's history - but memory crosses forks, gated on
the criterion's compiled definition (flag included) read from the spec
compiled at each source's own base revision, git-ancestry enforced,
red strictly preceding green, synthesis across runs naming both runs.
8 red oracles committed pre-run (03efe6b); the operator-authorized
revert 25be15b restored criterion-challenge CHAL-004-A's flag so the
fix's own consumer table carries the proof.

Runs: run-mw8e91ek FAILED on one TS2345 (ctx.meta.baseRevision
string|undefined into a string parameter - vitest transpiles without
typechecking so the unit oracle passed locally while every criterion's
tsc build prefix failed; the failed verdict was correct). Fresh run
per the house rule: run-mw8eh0db satisfied all three with the type
guard. First materialization: run-mw8elfbw (criterion-challenge, digest
9e3d1991, flag restored) - ALL SIX satisfied, CHAL-004 via a flip
established in prior chain runs (synthesis: red in run-mw81uztk's red
sweep, green in run-mw86ka7e's sweep; run-mw88o1xp's de-flagged
evidence invisible to the restored definition by the flag-in-digest
gate).

Adversarial pass on the delta: NEEDS-RECTIFICATION. The core gate was
cleared - no fabrication through digests (zod strictObject +
discriminatedUnion, SPC1001 duplicate-id rejection, deterministic
JSON through one pipeline), phases (schema allows only "red" or
absent), eligibility (isEligibleRed applied identically), ancestry
direction, or legacy shapes. F1: the unconditional source scan
resurrected SUPERSEDED runs - spc run supersede promises "no ancestry,
no evidence inheritance" and the scan violated an older contract than
the one being fixed. F2s: createdAt string-fallback could invert
red/green chronology; raw spawnSync bypassed the repo's git-deadline
hardening. Rectified through a fresh run (4 red oracles, run-mw8f7ila
satisfied): pure selectFlipSourceMetas (supersession set, createdAt
required, kind === apply with legacy prefix fallback, git via the
repo adapter), criteria.ts's stale "parentRunId chain only" comment
restated. Final materialization under the rectified code:
run-mw8fkl0b - all six satisfied again, sources undisturbed.

RECORDED NOT TAKEN: specs using imports: compile relative to the
importing file and are conservatively skipped as sources (scratch
relocation breaks SPC1007 - a functionality gap without signal,
disclosed in the module docblock); synthesized provenance
(redRun->greenRun) renders in criterion details but is not persisted
as structured state; the CLI's inherited-from-chain counters match a
pre-existing property-level reason string and under-count
criterion-level memory (pre-existing, unrelated to this delta).

Proof: chain-memory oracle 13/13; stage-6 verifies exit 0 (100%
reuse); criterion-challenge satisfied twice under fork memory
(run-mw8elfbw pre-rectification, run-mw8fkl0b post-); CI watched on
the satisfaction commit.
