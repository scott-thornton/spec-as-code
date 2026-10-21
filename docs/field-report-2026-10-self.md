# Field report: the longest self-hosting run

October 2026.

## Scope and disclosure

This report covers ~48 hours of continuous self-hosting: spc
developing spc, ending 21 October 2026. The author of the tool was
also the answering agent behind its harness provider for every run —
planning, executing, verifying, and amending through the same queue
any external agent uses. The session survived multiple context
compaction events; work continued from records, not memory.

Disclosures that bound every number below:

- **n = 1, and it is the builder.** Builder bias is total here: the
  author knew every mechanism before using it. Nothing establishes
  behavior for a stranger.
- **The agent is also the tool's author, so every "the system caught
  the agent" event is the system catching its own builder.** That is
  the point of self-hosting, but it caps how far the findings travel.
- **No baseline.** The same features were not built through a plain
  agent for comparison.
- **The false-completion rate remains unmeasured.** What is
  observable is, again, refusal-to-lie: no run recorded a green its
  evidence did not support.

## Usage at a glance

| Metric | Value |
|---|---|
| Calendar span | ~48 hours, 19–21 October 2026 |
| Apply transactions | 29 (plus standalone verify runs) |
| Specs in the repository at close | 31 (from 2 at start) |
| Properties satisfied at close | 161, with 0 unsatisfied or indeterminate |
| Commits | 93 (from the session's base revision) |
| Answered executor requests | 56 |
| Change ops emitted | 4,179: 3,745 patch / 231 update / 203 create |
| Patch share of update-shaped ops | 94% (90% of all ops incl. creates) |

The previous consumer field report (3 weeks, one production
repository) answered 101 requests across 39 runs. This session is
comparable in request volume at far higher spec density — the tool was
its own heaviest user for two days.

## What the experience established

### The author was the oracle problem, and the boundary caught it every time

Eleven defective acceptance-oracle artifacts were authored in this
session. The detecting mechanism and stage for each:

| Defect | Caught by | Stage |
|---|---|---|
| Tautology assertion (could not fail) | Author re-read | Authoring (before any run) |
| Fixture arithmetic (count 2 vs 3) | Criteria refused to flip | In-run verification |
| Circular type annotation | Typecheck criterion | Post-amendment gates |
| Schema navigation (`anyOf` vs `oneOf`) | Criteria refused to flip | In-run verification |
| Missing `git init` (verify-run fixture) | Criteria refused to flip | In-run verification |
| Missing `git init` (agent-show fixture) | Criteria refused to flip | In-run verification |
| `.not()` syntax slip | Typecheck criterion | In-run gates |
| Fixture committed the dirt it tested | Criteria refused to flip | In-run verification |
| Wrong helper argument (`repo` vs runs dir) | Unit oracle failure | Authoring (direct test run) |
| Hardcoded zero digest in plan | `PLAN_INVALID` preflight | Apply preflight |
| Missing field in hand-built result literal | CI typecheck | Downstream (outside SPC gates) |

Six were caught by SPC's own verdict or preflight machinery; two by
typecheck criteria (conventional tooling executed inside an SPC gate);
one by CI outside any SPC gate (the local build's tsconfig excludes
tests — a gate-coverage lesson, since fixed by making typecheck the
criterion); two by the author before submission. The final column is
the finding: the author caught two of eleven before betting a run.
Prose discipline did not reduce the error rate; mechanical checks
caught what discipline missed. The lint rules shipped during the
session are largely these failure modes mechanized.

### The runtime never promoted a requirement without recorded supporting evidence

Across 29 transactions, no requirement reached satisfied status except
through criteria that executed and passed against the declared
contract. This is the precise guarantee observed — it is evidence-
backed acceptance, not semantic correctness: a weak oracle can still
execute, pass, and satisfy a requirement the author intended to test
more strongly. What never happened was promotion without the evidence. The mechanisms that failed were
the author's, not the system's: protected-path enforcement refused and
reverted a protected-oracle edit made inside a task window (working
exactly as designed); the conclusion guard existed but never fired
because its cause had been fixed upstream; delta enforcement caught
every out-of-scope write. Under fatigue and deadline pressure, from
the inside, the boundary held.

### The patch protocol changed the author's behavior

Patch ops were 94% of update-shaped operations (3,745 of 3,745 + 231
patch-plus-update ops; 90% of all 4,179 including creates) — and the
share was 94% in both halves of the corpus, so adoption was immediate
and stable, not a gradual drift. (An earlier draft claimed usage "rose
to" 94%; the data does not support a trend, and the claim is
corrected here.) Five separate anchor-construction mistakes were
refused at composition time — the wrong closing brace, a trailing
newline where the file continued, a duplicate tail — each caught at
zero retry cost. The strictness of the runtime trained the
probabilistic participant to be more careful; the participant did not
get sloppier under load. Compression worked as measured: update
emission collapsed toward intent-sized patches.

### Compaction is the conversation-replacement thesis, experienced

The session opened at a documented full-context boundary: the entire
prior conversation had been summarized. What was consulted
immediately after: the conversation summary, the `specs/` directory
(which then contained three specs: self-hosting, verify-all-specs,
attest-verify-runs), and the `.spc/runs/` records.
What was accomplished after: 29 apply transactions, 28 additional
specs, and 93 commits — every one traceable to records, none to
memory of the lost context. The session-level orientation command
(`spc brief`) was built during this session, partly for the
post-compaction version of the author. The durable entities carried
the work; the agent was a participant that could be replaced by a
fresh context.

### The one circumvention, and what it cost

The external-review security fixes (four findings) were applied as
direct edits, rationalized at the time as "interlocking changes," and
the rationalization was repeated in the summary until challenged. The
work was correct; the record has no apply run, no task events, no
attestation anchoring those changes. Every other transaction of the
session has a full lineage. The cost of bypass is not correctness —
it is the missing proof structure. This is the strongest single
argument the session produced for why the loop matters even when the
author is confident.

### Ceremony was never skipped — and that is a finding too

The compressed-transaction mode was never used once, across the whole
session: every change, down to a two-line prompt edit, went through
the full spec → plan → apply → verify ceremony with a protected red
oracle. The author chose oracles every time because quick mode does
not give a protected oracle. The tension is real: the tool's
discipline is strong enough that its own author skipped the cheap
rung. The reconciliation — commit the protected failing test first,
then gate the compressed run on that test — was written into the
skills at the end, shaped by observed behavior rather than upfront
design.

## What the experience earned the roadmap

One concrete improvement, born of measured need rather than
speculation: **pre-commit oracle validation**. Four oracle amendments
were committed mid-session because the oracle had bugs the run later
discovered. The dry-run machinery checks a draft answer before
submission; nothing checks a draft spec's protected oracle before a
run is bet on it. Running the oracle at HEAD pre-commit — does the
suite collect, does it fail for the intended reason — would have saved
four amendments this session alone.

## The two reports together

The consumer report (three weeks, one production repository) showed
refusal-to-lie under real ticket pressure. This report shows the same
refusal directed at the tool's own author under self-hosting
pressure. Both arrive at the same conclusion from opposite
directions: the deterministic boundary holds precisely where the
probabilistic participant — whether a stranger or the builder —
does not.
