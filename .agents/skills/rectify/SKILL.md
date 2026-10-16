---
name: rectify
description: Turn adversarial-pass findings or discovered damage into a rectification spec instead of editing the original spec after runs exist. Use when findings are triaged contract-gap, when a pass exposes requirements the spec never covered, or when a chain of amendments has drifted and needs a clean restatement.
---

# rectify: rectification specs

The rule: an adversarial pass that changes what you should have meant is
new intent, and new intent gets a new contract. Never edit a spec after
runs have pinned evidence to its digest - the old spec was not wrong to
verify, it was no longer enough.

The crisp test for when this skill applies: did the finding expose an
implementation defect (the code breaks the contract - fix the code) or a
contract gap (nobody ever required this - author a rectification spec)?
Patching code to satisfy a gap launders the gap into fake green.

## Authoring the rectification spec

1. Collect the findings (structured output of `adverse-review`, or a
   run's follow-ups/unsatisfied reasons).
2. Create `specs/<original>-rectify-<NN>.yaml`. State the lineage in the
   title ("X rectification after pass P") and cite each finding id in
   the originating requirement's `metadata` (e.g.
   `metadata: { finding: F3 }`) - free-form and digest-covered.
3. One requirement per finding. The finding's statement is the fact; the
   acceptance criteria are yours to author - that decision stays human.
4. The original spec stays untouched and becomes a regression gate:
   after the rectification run, `spc verify` it too - the fixes must not
   break what already held.
5. Behavior-changing requirements get `discriminating: true` criteria
   (they must fail before the fix); preservation requirements do not.
6. `spc spec validate`, `spc plan`, `spc apply`, then run the PR through
   `adversarial-pr` like any other change.

## When to amend instead

A criterion that is merely wrong (imprecise grep, wrong expectation)
before meaningful runs exist: fix it in place. After runs exist, even
criterion fixes belong in a rectification spec or a fresh spec version -
the digest change invalidates old plans (SPC2009) either way, so make
the history say why.

## Compaction

After several rectification specs chain up, author one clean restatement
spec that supersedes the chain (say so in its title and goal), verify it
against the current tree, and retire the old files from active planning.
Append-only records need occasional snapshotting, or you trade spec
drift for spec archaeology.
