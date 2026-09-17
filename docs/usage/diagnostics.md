# Diagnostics reference

Diagnostics are compiler-grade: stable codes, severity, message, and source
location (file, line, column) with an excerpt where the input is available.
This page lists every code, what it means and how to fix it.

## Spec compiler (SPC0xxx, SPC1xxx)

### SPC0001 YAML_PARSE_ERROR

The file is not valid YAML, has multiple documents, duplicate mapping keys,
cyclic aliases, or an unsupported node.

Fix: the diagnostic carries the offending line and column; re-read the
excerpt under the caret.

### SPC0002 SCHEMA_INVALID

The parsed YAML does not match the spec schema (wrong type, missing
required field, bad enum value). The message names the field path.

Fix: correct the named field; see the
[spec authoring reference](spec-authoring.md) for field shapes.

### SPC0003 UNKNOWN_FIELD

A field the schema does not know. Specs are strict: unknown keys are errors,
not warnings.

Fix: remove the field or check the reference for the correct name.

### SPC0010 SPEC_NOT_FOUND

A plan references a spec id that cannot be found under `specs/` (or the
spec file passed to a command does not exist).

Fix: put the spec file in place, or fix the plan's spec id.

### SPC0011 NOT_A_GIT_REPO

The target directory is not inside a Git repository. spc operates on Git
repositories (observation, worktrees, revision-pinned evidence).

Fix: `git init` and commit, or point `--cwd` at the right directory.

### SPC1001 DUPLICATE_PROPERTY_ID

The same property id (or acceptance criterion id) appears twice in one
file, or in two files of an import graph. Ids are identity; they are never
merged or rewritten.

Fix: rename one of them. Remember id changes are semantic changes: plans
and evidence referencing the old id become stale.

### SPC1002 UNKNOWN_PROPERTY_DEPENDENCY

A `dependsOn` entry names a property that does not exist in the composed
spec.

Fix: correct the id or define the property. The diagnostic lists defined
ids as related information.

### SPC1003 PROPERTY_DEPENDENCY_CYCLE

`dependsOn` chains form a cycle; the diagnostic shows the chain.

Fix: break the cycle; if two properties truly require each other, they are
one property.

### SPC1004 MUST_PROPERTY_WITHOUT_ACCEPTANCE

A must property has no acceptance criteria, so it can never be verified.

Fix: add criteria, or honestly downgrade the priority to `should`/`may`.

### SPC1005 OPTIONAL_PROPERTY_WITHOUT_ACCEPTANCE (warning)

A should/may property has no criteria; it compiles but cannot be verified
mechanically.

Fix: optional; add criteria or accept the warning knowingly.

### SPC1006 SPEC_IMPORT_CYCLE

`imports:` form a cycle (a -> b -> a). The diagnostic shows the chain.

Fix: extract the shared properties into a third file both import.

### SPC1007 SPEC_IMPORT_NOT_FOUND

An imported spec file does not exist or cannot be read. Paths resolve
relative to the importing file.

Fix: correct the path.

### SPC1008 SPEC_IMPORT_ID_COLLISION

Two files in an import graph define the same property id. Ids are never
rewritten on composition; collisions are hard errors naming both files.

Fix: rename one; prefix conventions (SEC-*, AUTH-*) keep this rare.

### SPC1009 HIGH_ASSURANCE_WITHOUT_DETERMINISTIC_VERIFICATION (warning)

A must property categorized `security` or `compliance` is verified only by
agent or human criteria. High-assurance claims deserve command or file
evidence wherever possible.

Fix: prefer a test or static assertion; keep the agent/human criteria as
complements, or accept the warning explicitly.

## Plan validator (SPC2xxx)

### SPC2001 DUPLICATE_TASK_ID

Two tasks share an id.

### SPC2002 UNKNOWN_TASK_DEPENDENCY

A task depends on an id no task has.

### SPC2003 TASK_DEPENDENCY_CYCLE

The task graph has a cycle; the chain is shown.

### SPC2004 UNKNOWN_PROPERTY_REFERENCE

A task's `satisfies` or `verifies` names a property not in the spec.

### SPC2005 MUST_PROPERTY_NOT_COVERED

A must property is not addressed by any task (no `satisfies` or `verifies`).

Fix: plan work for it, or it is already satisfied and should be verified
instead.

### SPC2006 MUST_PROPERTY_NOT_VERIFIED

A must property has neither a verify task nor a command/file acceptance
criterion; there is no verification path for it.

### SPC2007 CONCURRENT_WRITE_CONFLICT

Two tasks write overlapping paths with no ordering dependency between
them.

Fix: add `dependsOn` ordering or merge the tasks. The overlap list is
attached.

### SPC2008 PLAN_SPEC_ID_MISMATCH

The plan's spec id differs from the spec it was validated against.

### SPC2009 PLAN_SPEC_DIGEST_MISMATCH

The spec changed after the plan was generated.

Fix: re-run `spc plan`; stale plans are refused on purpose.

### SPC2010 INSPECT_TASK_HAS_WRITES

An inspect task declares write targets. Inspection is read-only.

### SPC2011 UNSAFE_TARGET_PATH

A target pattern is not a safe relative path (absolute, `..` segments, or
not a valid pattern).

### SPC2012 AMENDMENT_TASK_NOT_FOUND

The amendment references a task that does not exist.

### SPC2013 AMENDMENT_TARGET_EXECUTED

The amendment tries to remove, replace or retarget a task that already
executed. Execution history is immutable.

### SPC2014 AMENDMENT_DUPLICATE_TASK

The amendment adds a task id that already exists.

### SPC2015 AMENDMENT_CYCLE

The amendment's dependency change would create a cycle.

## Runtime error codes

These appear as `error <CODE>: message` from the CLI (exit `2`) and as
typed errors in library code. Common ones:

| Code | Meaning |
| --- | --- |
| `DIRTY_REPOSITORY` | Tracked changes in the working tree at preflight. Commit or stash, or pass `--allow-dirty`. Untracked `.spc/` state never triggers this. |
| `PLAN_INVALID` | The plan failed deterministic validation; diagnostics included. |
| `PLAN_APPROVAL_REQUIRED` | `requirePlanApproval` is on and the plan is unapproved. Run `spc plan approve <id>`. |
| `BLOCKED_BY_FOLLOWUP` | Open blocking follow-ups from earlier runs of this spec. Resolve them or pass `--force`. |
| `PLAN_NOT_FOUND` | No plan file matched the argument (or none exist yet). |
| `SPEC_NOT_FOUND` / `SPEC_FILE_NOT_FOUND` / `SPEC_INVALID` | Spec missing or invalid; diagnostics included. |
| `NO_PROVIDER` | The command needs a model provider and `provider.name` is `none`. Configure a provider. |
| `PROVIDER_CONFIG` | Provider configuration is incomplete (missing model, key env unset, fake script missing). |
| `RUN_NOT_FOUND` | No such run under `.spc/runs`. |
| `RUN_ALREADY_FINISHED` | The run is terminal; only `running` runs can be resumed or cancelled. |
| `GIT_ERROR` / `WORKTREE_ERROR` | A Git operation failed; the command and stderr are included. |
| `RECONCILE_PLAN_FAILED` | Reconciliation drifted and the next transition failed validation; diagnostics included. |

## Event-level outcomes

Not errors, but you will see them in logs and summaries:

| Marker | Meaning |
| --- | --- |
| `OUT_OF_SCOPE_WRITE` | An executor's actual Git delta left the task's declared write targets; the task failed and the violation is recorded as contradicting diff evidence. |
| `EXECUTION_CONFLICT` | A task patch conflicted during deterministic merge in a parallel run; the integration branch was restored untouched and the task failed. Never silently resolved. |
| `MODEL_BUDGET_EXCEEDED` | `execution.maxModelCalls` reached; the task failed rather than looping. |
| `PLAN_STALE` | Plan digest no longer matches the spec (surfaces via SPC2009 at validation). |

## Evidence outcomes

Every evidence record carries one of: `supports`, `contradicts`,
`inconclusive`. Contradictions are retained forever; they are never deleted
because a later run succeeded. Requirement status is derived from the full
evidence set per criterion, with the strongest evidence winning ties within
a criterion and any authoritative contradiction forcing `unsatisfied`.
