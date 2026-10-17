# Field report: three weeks of spc in production

October 2026.

## Scope and disclosure

This report describes roughly three weeks, ending mid-October 2026, of
spc governing agent-driven changes in one production repository: a
commercial consumer application, actively shipped, with real release
constraints. The work was ticket-scoped feature work carried out by a
coding agent under spc's harness provider, with human review at the
merge boundary.

Disclosures that bound every number below:

- **n = 1 developer, and that developer built spc.** Builder bias is
  real: the tool's mental model was already internalized, and rough
  edges were forgiven that a stranger would not forgive.
- **No controlled baseline.** The same tickets were not run through a
  plain-agent arm; nothing here establishes better correctness or
  productivity versus a plain agent. The comparisons below are against
  the tool's own guarantees, not an experiment.
- **No independent audit of outcomes.** "Succeeded" runs were not
  audited against their specs by a second party, so the actual
  false-completion rate - the metric the tool exists to suppress -
  remains unmeasured here. What is observable is refusal-to-lie at the
  run level.
- **Repository, ticket content, specs and code are withheld** (they
  belong to the operator); what follows is counts, statuses, classes
  and timelines. Criterion text is described by class, never verbatim.

## Usage at a glance

| Metric | Value |
|---|---|
| Calendar span | ~3 weeks, ending mid-October 2026 |
| Runs | 39 total: 20 apply, 19 standalone verify |
| Feature specs driven | 5 substantial (plus iterations/renames) |
| PRs reaching merge | 3 merged, 2 open at cutoff |
| Answered model requests | 101 |
| Events / evidence records | 5,934 / 2,063 |

## Outcomes

Run statuses: 14 succeeded, 15 partially satisfied, 3 failed,
2 cancelled, 1 blocked, 2 stale-marked-running (abandoned; see
Hygiene), and 2 early verify runs that left no state file (counted in
the 39 total, excluded from verdict tallies). Requirement-level
verdicts, summed across all runs - a requirement verified in five runs
counts five times; this is not a count of distinct requirements
delivered: **340 satisfied, 26 unsatisfied, 8 indeterminate,
60 unknown** (the unknowns cluster in abandoned and early runs).

Three observations matter more than the counts:

**Fifteen runs refused to claim success they could not prove.** In this sample, the
dominant cause of "partially satisfied" was acceptance criteria that
required device or live-browser verification no in-process agent can
execute. The runs ended honestly - the property stayed unsatisfied and
the artifact recorded why - and 27 manual-verification follow-ups were
raised for the human. No instance of a run claiming success on
unverified work was observed - refusal-to-lie at the run level, not
proof-of-correctness (see disclosures).

**Four out-of-scope writes were caught and reverted.** All four were
accidental - the agent drifting beyond its declared write scope during
ordinary work, not evasion. Each failed its task, the write was
reverted, and the run continued or failed cleanly. Zero adversarial
evasion attempts were observed in three weeks. What that establishes is
narrow and worth stating precisely: the guardrails handled every
accident this sample produced. It establishes nothing about the
distribution of threats in general - absence of attacks in one
three-week, one-operator sample is not evidence that attacks are rare;
a motivated adversary was never pointed at the system (the sandbox
tier's trigger condition, deliberately unpulled).

**The audit trail was the most convincing artifact.** Merged PR histories read as
legible narratives - spec, apply, adverse-review amendment, decision
records, applies - reconstructible without opening spc's state at all.
The working answer to "why trust the agent's work" shifted from "the
model is good" toward "here is the record" - an observation from one
operator, not a measured effect.

## Friction (the credibility section)

**Answering cost was the tax.** 101 answered requests across the
period, at roughly 2-3 minutes per straightforward executor request
and considerably more for planner requests. One request recorded 23
attempt cycles before a valid answer landed - schema-validation
failures surfaced only after submission, each costing a round trip.
This single data point drove two tool fixes (a preflight validation
command and a timeout that no longer starves active iteration; see
What the data changed).

**Timeout starvation killed five tasks.** Tasks demonstrably being
worked - answers arriving, feedback cycles consuming the wall clock -
hit the fixed response window and died. The window was punishing
engagement, not abandonment.

**Criteria precision was the top recurring authoring bug.** Three
separate occurrences of grep-class gates matching the wrong things:
one catching planning documents that merely mentioned a removed
identifier, one catching its own test fixture, one under-matching a
rename. The failure mode is consistent: a substring gate encodes
"this string appears" instead of "this behavior exists." The remedy
adopted in the field was hand-written red-first acceptance suites and,
eventually, AST-based checks - both later absorbed into the tool
(`discriminating` criteria, red-phase evidence).

**Red-phase discipline emerged before the feature existed.** The
production repo was pre-committing failing acceptance suites by hand
weeks before `verification.requireRedPhase` shipped - the practice
pulled the feature into existence. Same for in-place execution
(requested after two days of worktree friction) and per-task commits.

**Session economics were better than feared.** One full answering
session: ~577K of 1M context consumed, 91.8% of it request/answer
traffic, 99.5% average prompt-cache hit rate. Counterfactual cost at
API list prices for the same token volume: single-digit dollars. The
"structured loop is token-expensive" objection mostly dissolves under
prefix caching; the real budgets are output tokens, wall clock, and
context-window occupancy (start a fresh session per major run -
compaction destroys both the cache and early answers).

**Hygiene debt accumulated quietly.** One run left "running" with seven
unanswered requests frozen for eight days before cancellation existed
as a habit. The harness directory grew unbounded (101 answered files).
Both are now tool-addressable (`spc run cancel`, the ignore policy),
but the lesson generalizes: append-only systems need scheduled
housekeeping or they rot.

## What the data changed in the tool

The corpus-to-fix loop, each traceable to numbers above:

- Every persisted `state.json` reported zero model calls while the
  event log held the truth - a projection sync bug found by simply
  reading real run data.
- The 23-attempt request led to `spc agent validate` (preflight schema
  checks) and the timeout-refresh-on-activity fix (five starved tasks).
- Verifying after an in-place run against the wrong tree produced
  phantom drift once - now the report states where results live and
  verify warns about unmerged run branches.
- Three criteria-precision incidents became the `author-spec` guidance
  (access expressions over bare identifiers, fixtures excluded, gates
  read and never write) and the protected-paths fence for oracles.

## Threat-model validation

The field data is consistent with the graded posture as designed:
accidents covered in the cases observed (four catches, all accidental);
casual malice unobserved; competent malice untested. The sentence this
sample supports best, stated with its bounds: **the failure mode
actually seen was a capable, sloppy agent on a trusted machine - and
against that, in these three weeks, the guardrails held each time they
were load-bearing.** One repository and one operator cannot carry that
sentence further.

## What would make this report stronger

- 5-10 additional repositories, strangers as operators.
- A controlled same-ticket baseline (plain agent vs spc) measuring
  false-completion and regression rates for matched cost.
- Independent audit of "succeeded" runs against their specs.
- Longitudinal data past the three-week novelty window.
