---
name: author-spec
description: Craftsmanship for writing specs and acceptance criteria that test what they claim. Use when authoring or amending a spec, when criteria keep flip-flopping between verify runs, when greps catch their own fixtures, or before planning anything with behavioral requirements.
---

# author-spec: criteria craftsmanship

A criterion is a claim about the world that must be able to fail. Most
spec pain is not bad code - it is criteria that test the wrong thing.

Most of the rules below are checked mechanically now: run
`spc spec lint <file>` before planning (validate folds the static
warnings; lint adds the red-capability check in a disposable worktree).
Read on for the judgment the machine cannot render.

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
- Gates read, they do not write: a criterion command must be
  side-effect-free (grep, test, lint against the tree). Anything that
  writes files is a task, not a gate - sweeps run commands without
  fencing the tree, so a side-effectful gate can write wherever it
  likes, after enforcement has already passed.
- Cost model: every criterion executes on every verification sweep.
  Targeted checks (one test file, one command) per requirement; the full
  suite backs at most one terminal criterion. One command per test FILE,
  not per test name - every command pays full tool boot (a spec file run
  as five `-t <name>` invocations pays five bootups, every sweep).
  Criteria that must catch cross-package interface breaks want a
  typecheck command, not just a build: build configurations commonly
  exclude test files, and a broken test-file literal once passed every
  build criterion - CI's typecheck caught it.

## Oracle provenance

An agent that can modify its own oracle can manufacture green. The
ladder, strongest last:

- **mutable**: everything a task may legitimately write (default).
- **protected**: fence it with `verification.protectedPaths` in config -
  no task may touch those globs, violations revert and fail the task.
  Fence the suites your criteria execute.

  Authoring consequence: when criteria execute files under protected
  paths, author and commit the failing oracle BEFORE apply - tasks
  cannot write protected paths, so a plan whose tasks would create the
  oracle fails with PROTECTED_PATH_WRITE by design. Commit spec and
  oracle together; the red phase then runs the committed oracle at the
  base revision.
- **external**: oracles that live outside the repo entirely - a CI-held
  script, a pinned fixture service - invoked as command criteria.
- **withheld**: values the agent never sees (secrets; presence-checked,
  never read).

When a task's write scope legitimately includes test files (TDD), make
sure the suites its own criteria execute are protected or external -
otherwise the same context writes the code and grades it.

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
