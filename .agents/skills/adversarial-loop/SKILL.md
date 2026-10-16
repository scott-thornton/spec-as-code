---
name: adversarial-loop
description: The adversarial review loop without the PR - two rounds of adverse review (via the adverse-review skill), rectification proved by spc verify, and a final gated pass, with everything recorded in a review log instead of PR comments. Use after an spc run completes but before opening a PR, when hardening work-in-progress, when no PR will exist at all, or when the user asks for adversarial passes on local work.
---

# adversarial-loop: adversarial review without the PR

Same choreography as `adversarial-pr`, minus GitHub: the target is an
spc run's diff (or any change set), findings and rectifications land in
a review log file instead of PR comments, and the final gate is the main
agent's sign-off. When a PR exists, use `adversarial-pr` instead - this
skill is for everything before (or instead of) that point.

Invariants (identical to the PR variant):

- Every reviewer/fixer subagent self-identifies in the log with the pass
  number and role. Only the step 5 record speaks for the main agent.
- Rectifications are proved by `spc verify`, never by the fixer's word.
- Findings address the contract, not vibes - structured output from
  `adverse-review` (id, severity, class, property ref, citation).
- The loop runs at most twice per invocation and never restarts itself.

## The record

Write one markdown log per invocation, default
`.spc/reviews/<spec-id>-<runId>.md` (create the directory; the file is
committable audit trail, unlike `.spc/runs`). Start it with the target
(spec id, run id, revision range) and append a section per step using
the same section formats as `adversarial-pr`'s comment templates.

## Step 1: adversarial pass 1 (subagent)

Dispatch a reviewer subagent running the `adverse-review` skill against
the run's diff, supplying the spec and run evidence
(`.spc/runs/<runId>/summary.md`, `spc status --format json`) as context.
Append its findings to the log. No fixes in this step.

## Step 2: rectification (subagent) + verify

Triage by class, exactly as in `adversarial-pr`:

- `implementation`: fix inside the plan's write scope.
- `criterion`: fix the criterion (`author-spec` precision rules); the
  spec digest changes, so a fresh verify must follow.
- `contract-gap`: no code fix. Note it as a rectification-spec candidate
  (`rectify`) for the human - patching code to satisfy a gap launders
  the gap into fake green.

Then run the deterministic sweep, not the fixer's opinion:

```bash
spc verify --format json
```

Append the rectification record: per-finding dispositions, per-property
verify outcomes, remaining-risk lines. If any must is unsatisfied or
indeterminate, stop and say so in the log; do not start pass 2 until a
rerun is clean or the residual is explicitly accepted in writing.

## Step 3: adversarial pass 2 (fresh subagent)

Fresh reviewer, same skill and format, with pass 1's findings and the
rectification record in context. Its extra target: did the fix address
the finding, or its letter? Append to the log.

## Step 4: rectification + verify

Identical to step 2 against pass 2 findings. Zero blocker/major findings
means record that and go to the gate.

## Step 5: final gate (main agent, never a subagent)

Check the whole stack: every must satisfied or explicitly waived; red
phase flipped where required; remaining risk understood; every finding
from both passes resolved, triaged or consciously accepted; provenance
honest throughout the log. Append the sign-off section (what was
verified, dispositions, residual risk accepted). If the work is heading
to a PR next, the log is ready evidence - attach it or fold its sections
into the PR body, then hand to the human. Nothing proceeds anywhere
automatically.
