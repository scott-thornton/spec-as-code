---
name: adversarial-pr
description: Adversarial review loop around a pull request for spc-run work. Two rounds of adverse review via the adverse-review skill (grounded in the spec and its evidence, not just the diff), subagent rectification verified by the deterministic sweep, and a final gated review before the PR is left for a human to merge. Use when a change driven by an spc run is ready to become a PR, when the user asks for an adversarial or red-team pass, or before merging substantial agent-authored work.
---

# adversarial-pr: adversarial review loop for spc PRs

A fixed sequence run at most once per PR. The loop converts judgment into
records: adversarial passes produce structured findings (via the
`adverse-review` skill), rectifications are proved by `spc verify`
(never by the fixer's word), and the final gate arbitrates only what
mechanics could not. spc itself never changes; every step consumes or
produces an spc artifact.

Invariants:

- Every comment posted by a subagent self-identifies with the pass number
  and role ("adversarial pass 1, reviewer subagent"). Only the step 5
  comment speaks for the main agent. The thread must never imply the human
  said something a subagent said.
- Nothing merges automatically. The loop ends with evidence, not a button.
- Findings address the contract, not vibes.

## Step 0: PR from run evidence

Generate the PR body from the run's own records, not from prose:

```bash
spc run pr <runId> --out /tmp/pr-draft.md
gh pr create --title "<ticket or spec title>" --body-file /tmp/pr-draft.md
```

The draft carries requirement statuses and evidence provenance. Add a short
summary section on top; do not strip the evidence sections.

## Step 1: adversarial pass 1 (subagent)

Dispatch a reviewer subagent running the `adverse-review` skill with the
diff as its target, supplying the spec file(s) and the run's evidence
(`.spc/runs/<runId>/summary.md` plus `spc status --format json`) as
context. It returns structured findings (id, severity, class
implementation/criterion/contract-gap, property ref, citation). Post them
as a PR comment using the template below. No fixes in this step.

## Step 2: rectification (subagent) + verify

Triage first, because the class decides the remedy:

- `implementation`: fix the code inside the plan's write scope.
- `criterion`: fix the criterion (see `author-spec` for precision rules).
  The spec digest changes: the PR must include the spec edit and a fresh
  verify.
- `contract-gap`: do NOT patch code to satisfy a gap - that launders the
  gap into fake green. Follow the `rectify` skill: propose a
  rectification-spec stub and leave it in the comment for the human to
  author acceptance criteria.

Fixer subagent applies the `implementation` and `criterion` remedies, then
the loop runs the deterministic sweep, not the fixer's opinion:

```bash
spc verify --format json
```

Post a rectification comment: one line per finding (`F1 fixed <sha>` or
`F1 triaged contract-gap, rectification spec proposed`), then the per
property verify outcomes, then `spc status` remaining-risk lines. If any
must is unsatisfied or indeterminate after the fixes, say so plainly and
do not proceed to step 3 until a rerun is clean or the residual is
explicitly accepted in the comment.

## Step 3: adversarial pass 2 (fresh subagent)

Same as step 1, but the reviewer is fresh context and receives the prior
findings and rectification comments too. Its explicit extra target: did
the rectification actually fix what pass 1 found, or did it satisfy the
finding's letter? Findings post as "adversarial pass 2, reviewer
subagent".

## Step 4: rectification + verify

Identical to step 2, against pass 2 findings. If pass 2 returns zero
blocker/major findings, record that and skip straight to step 5.

## Step 5: final gate (main agent, never a subagent)

Review the whole stack yourself before commenting:

- Latest `spc verify`: every must satisfied or explicitly waived.
- Red phase (if enabled): discriminating criteria flipped.
- Remaining risk section empty or understood.
- Every pass 1/2 finding resolved, triaged, or consciously accepted.
- The comment thread provenance is honest (subagent comments identified).

Only then comment the sign-off: what was reviewed, the verify outcome,
and any residual risk you are accepting. Final line is always the human
decision point, e.g. "Ready for human review and merge." If anything fails
the gate, comment what and stop; do not loop back automatically.

## Comment templates

Findings (pass 1 / pass 2):

```markdown
**adversarial pass N, reviewer subagent**

| id | severity | class | property | finding |
|----|----------|-------|----------|---------|
| F1 | blocker  | implementation | AUTH-003 | ... |

Notes: <one paragraph per blocker/major, citing diff or criterion ids>
```

Rectification (step 2 / step 4):

```markdown
**rectification N, fixer subagent; verification by spc verify**

- F1 fixed in <sha> (verify: AUTH-003 satisfied)
- F2 triaged contract-gap: rectification-spec stub proposed (no code change)
- ...

Verify outcome: <satisfied/unsatisfied/indeterminate per property>
Remaining risk: <spc status remaining-risk lines, or "none">
```

Sign-off (step 5, main agent):

```markdown
**final review, main agent**

Verified: <musts satisfied/waived, red-phase flips, evidence checked>
Resolved: <pass 1: N findings, pass 2: M findings - dispositions>
Residual risk: <accepted items, or none>
Ready for human review and merge.
```
