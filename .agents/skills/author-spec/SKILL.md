---
name: author-spec
description: Craftsmanship for writing specs and acceptance criteria that test what they claim. Use when authoring or amending a spec, when criteria keep flip-flopping between verify runs, when greps catch their own fixtures, or before planning anything with behavioral requirements.
---

# author-spec: criteria craftsmanship

A criterion is a claim about the world that must be able to fail. Most
spec pain is not bad code - it is criteria that test the wrong thing.

## Precision: match intent, not substrings

- Grep the access expression (`images.faviconUrl`), never a bare
  identifier (`faviconUrl`) - bare identifiers match test fixtures,
  generated code, and planning docs that merely mention the thing.
- Exclude what you do not mean: `':!**/__tests__'`, `':!**/generated'`.
  A gate that catches your own fixture data will flip every time someone
  touches the tests - the criterion fights the suite instead of the bug.
- Anything subtle (AST shape, import graph, "does not call X") deserves
  an AST-based check script, not string matching.
- A criterion that cannot fail is decoration. Ask of every one: what
  change would make this red? If nothing, delete or strengthen it.

## Classification

- Behavior the change introduces: `command` criteria, marked
  `discriminating: true` (they must fail on the current tree).
- Behavior that must keep holding: regression `command` criteria, NOT
  discriminating - they legitimately pass today.
- Structure that implies behavior: `file` criteria (contains/notContains).
- Judgment a machine cannot render, including device, browser and live
  e2e verification: `human` criteria with instructions specific enough
  that a person can execute them and record the outcome. Writing a
  device-shaped check as a `command` criterion manufactures a
  permanently unsatisfied requirement.
- Cost model: every criterion executes on every verification sweep.
  Targeted checks (one test file, one command) per requirement; the full
  suite backs at most one terminal criterion. One command per test FILE,
  not per test name - every command pays full tool boot (a spec file run
  as five `-t <name>` invocations pays five bootups, every sweep).

## Statements

Checkable claims, not vibes: "the app resets selections on cold launch",
not "startup is robust". Every `must` needs acceptance (SPC1004 exists
for a reason). `outOfScope` is a promise about what will not change -
fill it in honestly; it is what keeps plans from wandering.

## Write the failing test first, in the spec

The red phase lives in the spec, not the code: author discriminating
criteria before implementation so the red -> green flip is provable.
If you cannot write a criterion that fails today for a behavior claim,
that is a signal about the claim, not the mechanism.
