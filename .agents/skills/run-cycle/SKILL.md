---
name: run-cycle
description: Drive ONE spec through the complete spc loop from inside a tool harness - the minute-by-minute operating procedure, the clock discipline, the exact commands, and every failure mode with its recovery. Use at the start of any session that will plan, apply, or rectify under the harness provider; when a backgrounded spc command is waiting on you; when a request window is ticking; and whenever you are about to touch spc without having read this first.
---

# run-cycle: one spec, red to pushed, from inside a harness

You are the operator: the model behind the queue. spc blocks waiting
for your answers; this skill is the shift schedule. The stage map and
the answer mechanics live in their own skills (follow: spc use-skill
pipeline, spc use-skill answer-queue) - this one is the operating
procedure that binds them into a cycle you can actually run.

## The clock mismatch (read this before any command)

Your tool harness has one primitive: run a command, get its output.
`spc plan` and `spc apply` are **blocking calls that wait for you** -
they cannot finish while you are doing something else. Your bash tool
will background them at its own timeout (often 300s). That is normal
and harmless. Two rules follow:

1. **A backgrounded spc process is a commitment, not a fire-and-forget.**
   The moment it backgrounds, START POLLING (`spc agent list` every
   30-60s) and answer each request **within seconds** of it appearing.
   Every request carries a response window (shown in `agent list`).
   An unanswered request expires into `.spc/harness/stale/` - dead,
   unanswerable, the run lost. This is the single most common way to
   burn a cycle. Do not go read documentation while your window ticks.
2. **Never stop a backgrounded spc process.** Stopping the waiter
   orphans its request instantly. To end a run, `spc run cancel <runId>`
   - and know what it can do. A run that no execution-intent record
   names is marked cancelled at once. Otherwise cancel completes when
   the owner is parked waiting on a request and sees the retirement. An
   owner that is already dead, or busy inside a command, is not stopped
   by it: on macOS the command prints `cancellation INCOMPLETE` and
   exits 1 after a 30s grace period. Then the way out is
   `spc apply recover`, once no spc process is writing - recover
   refuses while an owner is live.

```
tool timeout (300s)  <  response window (40-60m)
   plan/apply background -> you poll -> request appears -> answer NOW -> run continues
   drift past the window -> stale/ -> tombstone -> re-run plan, nothing else recovers it
```

## Invocation

The CLI is `node packages/cli/dist/main.js <cmd>` (called `spc` below;
substitute the long form when no alias is linked). Build before any
session: `pnpm --filter @spc/cli... build > /dev/null`. Append
`--format json` to read commands for machine-readable output.

## Pre-flight (once, before the cycle)

1. `spc brief` - orient: specs, last runs, blocking follow-ups, queue.
2. `git status --short` - the tree must be **clean** before any run.
   Stash stray/staging specs now (`git stash push -u -m "parked" --
   <paths>`), pop after push.
3. Check the harness queue is empty (`spc agent list`) - a pending
   request from an earlier abandoned run will block or confuse.

## Stage 1-2: spec and red oracle

Author/validate the spec (`spc spec validate specs/<id>.yaml` must
print "Spec valid"; craftsmanship: follow: spc use-skill author-spec).
Write the oracle test(s) the criteria execute, then prove red:

```bash
pnpm --filter <pkg>... build > /dev/null && pnpm --filter <pkg> exec vitest run src/<oracle>.test.ts
```

Three traps, each burned a real cycle:
- **The build prefix is part of the contract.** If the criterion
  command has one, run `pnpm --filter <pkg> build` once before
  trusting a local green - vitest does not typecheck; CI's tsc will
  (TS2554/TS2345-class failures pass locally and redden CI).
- **Confirm red for the right reason** - read the assertion output,
  not just the exit code. Then commit spec + oracle together:
  `git commit -m "spec+red oracle: ..."`.
- **An unmatched title filter is green.** vitest exits 0 when its `-t`
  filter selects no test, and any exit 0 is a pass. Prefer whole-file
  criteria; if you must filter, read the red output and confirm tests
  ran.

## Stage 3: plan

```bash
spc plan specs/<id>.yaml        # background it; it BLOCKS polling for your answer
```

Poll until the planner request appears (`planner-planner@N-xxx
[planner] PlannerOutput live`), then answer immediately:

```bash
sleep 60 && spc agent list      # repeat every 30-60s; do not do other work
# write plan.json (shape below)
spc agent respond <request-id> --file plan.json
```

The planner answer shape (minimal valid value, nothing extra):

```json
{ "plan": { "tasks": [ { "id": "T001", "title": "...",
    "kind": "modify", "intent": "<what and where, precisely>",
    "dependsOn": [], "satisfies": ["REQ-001"],
    "targets": { "read": ["..."], "write": ["<EVERY file the task may touch>"] } } ] },
  "observations": [], "assumptions": [], "followups": [] }
```

Rules the deterministic validator enforces (refusals requeue with the
error; fix and resubmit the same request id):
- **Every must-property addressed** via `satisfies` (modify) or
  `verifies` (verify) - else `SPC2005 ... not addressed`.
- Task ids `T###`; write targets explicit; **one writer per path**.
  Under the default configuration, a later task is refused
  `UNMEDIATED_CHANGES` when its
  declared write targets overlap a path an earlier task changed -
  even if it never touches that path (reproduced 2026-11-24: eight
  executor round-trips, then the task fails), so put both edits in
  one task. Minimum task set - a task only confirming existing
  state is a correct verify task.
- Rejected answers: read the feedback in the requeued request, fix the
  JSON, respond again with the same id.

Read the plan process output: `Persisted: .spc/plans/plan-<date>-<seq>.json`.
**Copy that exact path** - apply takes it explicitly. (Never
newest-file glob: a retrying plan process rewrites mid-glob.)

## Stage 4-5: apply

```bash
spc apply .spc/plans/plan-<date>-<seq>.json    # background; BLOCKS per task
```

Poll the queue; answer each `executor-T00N@...` request **the moment
it appears**. The executor answer shape:

```json
{ "status": "completed", "summary": "<what was done>",
  "changes": [ {"op": "update", "path": "<rel>", "content": "<FULL new file content>"},
               {"op": "patch", "path": "<rel>", "baseDigest": "sha256:<hash>",
                "anchor": "<exact byte-unique text>", "replacement": "<new text>"},
               {"op": "create", "path": "<rel>", "content": "..."} ],
  "commands": [], "observations": [], "evidenceCandidates": [], "followups": [] }
```

- `update` takes **no** baseDigest; `patch` requires it. Compose with
  `spc patch build --batch <spec.json> --out <ops.json>` - never
  hand-type a digest, and never retype an anchor: cut it out of the
  tree (`sed -n '12,14p' <file> > anchor.txt`) and write the
  replacement to match it line for line. A replacement one line longer
  than its anchor cost a run (a stray closing brace).
- The last four fields are REQUIRED by the request's schema even
  when empty. `spc agent validate <id> --file <answer.json>` rejects
  an answer without them - validate before every respond.
- Rehearse before you respond: `spc agent dry-run <id> --file
  <answer.json>` (about 30s). It checks out the run's base, applies
  this one draft there, builds, and runs the task's file and command
  criteria. Omit `--gates`: the rehearsal already builds, and a bare
  `--gates` runs every root gate including the full test battery.
- Read the rehearsal's verdict for what it can vouch for. It is
  faithful only for a task that depends on nothing in flight,
  earlier or later. Another task's work is absent from the base
  checkout, so a red criterion does not convict the answer when this
  task's criteria need that work. A refused staging is a wrong
  operation, an overlap the guard will refuse too, or - in a
  worktree-mode run - this task's own earlier applied work, which the
  guard accepts. For composition alone, `spc patch verify <ops.json>`
  runs the changes through the applicator in memory against the live
  tree and runs no criteria.
- `spc agent respond` refuses exactly one shape on rehearsal grounds:
  two or more patch operations on one path when no rehearsal matches
  the exact draft. It prints `PREFLIGHT_ADVISABLE` and exits 1. Rehearse
  that answer, or pass `--no-preflight`. (`spc agent submit` is
  respond with the rehearsal built in.)
- The request's system prompt carries the full executor contract -
  read it once per session. `agent show <id> --part schema` for the
  exact JSON Schema.
- A requeued request with `lastError` = your answer failed validation:
  fix the shape, keep the substance.
- Executor requests are bounded one-task work - delegable to a cheaper
  subagent for drafting; you review and submit.

After the last task the run sweeps every criterion. Read the verdict
from the background task's output file: the requirement table
(`satisfied` / `indeterminate` / `unsatisfied` per property).

## Stage 6: verify

```bash
spc verify specs/<id>.yaml       # one spec: must end all satisfied, exit 0
spc verify <id> <id>             # N specs: exactly those, by path, file stem or spec id
```

Bare `spc verify` runs every spec - do not type it by accident. A name
that matches nothing fails with exit 2 instead of verifying less.
A run that changes the red-phase / oracle-identity gate cannot validate its own repair:
its properties read indeterminate, and a fresh `spc verify` is the evidence.
Any other indeterminate is a finding - triage it.

If the run ended red or partial: triage before retrying (follow: spc
use-skill handle-partial). Diagnose from evidence, not the summary -
and from the END of it, because runners print failures last and
captured output is cut to its first 64 KiB. The recipe skips the
red-phase records: their red is the expected one.

```bash
python3 -c "import json
for l in open('.spc/runs/<runId>/evidence.jsonl'):
    e=json.loads(l)
    if e.get('outcome')!='contradicts' or e.get('phase')=='red': continue
    p=e.get('payload',{})
    for k in ('stdout','stderr'): print(e.get('criterionId'), k, '...', str(p.get(k,''))[-2500:])"
```

Fixes go **through the loop** - a fresh `plan`/`apply` whose executor
changes carry the fix. Hand-editing the tree is the unmediated change;
the guards catch it (UNMEDIATED_CHANGES, digest drift, write scope),
and they are right to.

## Stage 7: adversarial, review log, push

1. **Adversarial pass** - dispatch a READ-ONLY subagent over the delta
   (the full skill: follow: spc use-skill adversarial-loop). Findings:
   F1/F2 rectify through a fresh run; F3 to backlog. Run it every
   cycle; it caught real F1s in three of four consecutive specs.
2. **Review log** at `.spc/reviews/<spec>-run-<runId>.md`: what
   shipped, both passes' findings, recorded-not-taken items, run
   history with lumps disclosed. Commit it.
3. **One push**, then watch **both** CI jobs to completion:

```bash
git push origin main
gh run list --branch main --limit 2
gh run watch <runId> --exit-status      # 'ci' AND 'spc-verify' must both be green
```

`ci` runs the batteries (~minutes). `spc-verify` re-executes every
criterion honestly: minutes when the command cache hits, up to ~2h
after scope-machinery changes. Local batteries are forbidden (RAM
discipline); CI owns suites. Pop stashed staging specs after push.

## Failure modes: symptom -> recovery

| Symptom | Cause | Recovery |
|---|---|---|
| `DIRTY_REPOSITORY` on apply | untracked/modified files | stash; pop after push |
| `SPC2005 ... not addressed` | must-property without satisfies/verifies | fix plan JSON, resubmit same id |
| `SPC2009` spec digest drift | spec edited after planning | re-plan against the new digest |
| `PATCH_BASE_MISMATCH` | tree moved since digest | re-hash, rebuild op via patch build |
| `OUT_OF_SCOPE_WRITE` | file not in targets.write | re-plan with the target; never widen silently |
| executor answer refused: missing `commands` / `observations` / `evidenceCandidates` / `followups` | the four fields are required even when empty | add the empty arrays; validate, then respond |
| `PREFLIGHT_ADVISABLE` from spc agent respond | two or more patch ops on one path, and no rehearsal matches this exact draft | rehearse that answer, or pass `--no-preflight` |
| criterion red in `spc agent dry-run` | the rehearsal checks the base plus this one draft: another task's work, earlier or later, is absent | red does not convict the answer when this task's criteria need that work |
| staging refused in `spc agent dry-run` | a wrong operation; an overlap the guard will refuse too; or, in a worktree-mode run, this task's own earlier applied work | fix the op, or re-plan so one task owns the path; the last case needs nothing |
| request found in `stale/`, queue empty | window expired or process stopped | re-run plan/apply; answer fast |
| run `running` but nothing happens | abandoned run | `spc apply --resume <runId>`; to abandon it, `spc run cancel <runId>`, then `spc apply recover` if it prints `cancellation INCOMPLETE` |
| `cancellation INCOMPLETE` from spc run cancel | owner dead or busy, not parked on a request (macOS) | `spc apply recover` once no spc process is writing |
| every property indeterminate in an apply run that changed the red-phase / oracle-identity gate | the applying process judges its own sweep with the old code in memory | expected once; `spc verify` in a fresh process |
| `SPEC_FILE_NOT_FOUND: no spec matches` from spc verify | a path without its extension is not a file | use the id (`spc verify chain-memory`) or the full path |
| `indeterminate` + `SYNTHESIS_REJECTED` events | oracle-identity gate refusing a drifted pairing | by design; fresh in-run flip re-establishes |
| ghost run dirs (events, no metadata) | aborted apply attempts | exclude from history searches; never counted |
| crash-wedged challenge worktrees | hard-interrupted run | the engines pre-clean; older trees: `git worktree prune` + rm |

## Never

- Kill or stop an spc process by hand - `spc run cancel`, then
  `spc apply recover` if it reports incomplete.
- Run full test batteries locally - single-file oracles only; CI owns
  suites.
- Let a minted request sit while you do other work.
- Trust a green you have not seen red (and for the right reason).
- `rm -rf .spc/harness/stale` to "clean up" - archive it; it is the
  forensic record of what expired. Match YOUR request id from YOUR
  plan output before diagnosing any file in there.
- Commit during a run; hand-edit `.spc/runs/`, `.spc/plans/`, or
  `.spc/harness/answered/`.
- Claim a requirement satisfied yourself - evidence decides, not you.
- Pad an answer with anything beyond the minimal valid value. That
  value still includes the four empty arrays.

## The discipline

> Orientation is re-derived on contact. A green you have not seen red
> is a rumor. And a request you answer late is a cycle you burn - the
> queue is a conversation, not a mailbox.

Companion skills: pipeline (stage map), answer-queue and rehearse
(answer mechanics, candidates, dry-run), author-spec (criteria
craftsmanship), handle-partial (triage), rectify (rectification
specs), adversarial-loop (the review pass). `spc skills` lists them.
