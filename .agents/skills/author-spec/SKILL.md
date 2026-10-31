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

## Renames: zero residual references

A rename's criteria must force coverage of every residual reference.
The rename updates the definition and the references the executor can
see - which is not every reference. The same rename task
false-completed in three campaigns across two models and three months:
it satisfied every written criterion and left a caller on the old name,
and the verifier blessed it, because nothing in the criteria forced
coverage. Add a zero residual references criterion - a command counting
references to the old name across the write scope, expecting zero:

    - id: X-001-B
      type: command
      command: "! grep -rq 'oldFieldName' src/"
      discriminating: true

Keeping an old-name alias for a migration period is legitimate - it is
your exception to declare explicitly in the criterion's expectation
(expect the alias file and nothing else), never an implicit gap the
verifier cannot see.

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
  paths, author and commit the failing oracle before apply - tasks
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

## Red oracle, then quick (the small-change recipe)

For a small, well-understood change, the cheapest honest path is to
commit the protected failing test FIRST, then gate a `spc quick` run on
that same test file:

1. Write the test; make it fail for the right reason; commit it (it
   lives under protectedPaths, so no run task may touch it).
2. `spc quick "<intent>" --verify "vitest run <that test file>"
   [--write <path>] [--stay]` - the gate is the oracle you already
   trust, the planner is skipped with --write, and the flip is provable
   because the test was red at the commit before the run.
3. Reserve grep-only gates for pure values (CSS literals, config
   constants) where a test file would be ceremony.

This worked cleanly in the field (CHK3555 quick chain, 4/4 green first
time once dry-run adoption kicked in) and should be the default shape
for logic changes that fit one task.

## Proposal-verification doctrine

> A proposal is not exempt from verification merely because it proposes
> a verification mechanism.

> Before adding a safeguard, establish which existing guarantee is
> missing, which failure demonstrates the gap, and which regression
> will prove the gap is closed.

These came out of an anchor-audit exchange (2026-10-23) in which both
sides proposed mechanisms that already existed or could not work as
described; checking the implementation first is part of authoring.

Practical corollary for criterion commands: in a pnpm workspace, a bare
`pnpm --filter X <cmd>` criterion compiles X against its dependencies'
STALE dist output - run-mvix4mfx verified against pre-change artifacts
and its criteria honestly refused the wrong thing. Criterion build
commands must be dependency-inclusive (`--filter X...`) or explicitly
prepare dependencies; `spc lint` flags the bare form as
LINT-FILTER-NO-DEPS.
