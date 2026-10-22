---
name: answer-queue
description: Answer pending spc harness requests as the model behind the file-based provider. Use when a run is waiting on .spc/harness/pending, when spc agent list shows requests, or when deciding how much care each request role deserves and what to delegate to subagents.
---

# answer-queue: answering harness requests

You are the model behind spc's harness provider. spc paused a run and is
waiting for structured answers; the run is only as good as what you send
back.

## The loop

```bash
spc agent list                 # what is pending
spc agent show <requestId>    # full prompt + response schema
spc agent respond <requestId> --file <answer.json>
```

## Role-based attention

- **planner / replanner requests**: contract decisions. Answer slowly.
  Read the spec properties and repository snapshot carefully; minimum
  task set; every must covered and verifiable. A bad plan is the most
  expensive mistake in the system - everything downstream is bounded by
  it.
- **executor requests**: bounded work. One task, declared write scope,
  provided context. These are delegable: hand the prompt and schema to
  a cheaper subagent, then review its draft yourself before submitting.
- **verifier (agent-criteria) requests**: judgment. Judge only what the
  evidence supports; inconclusive is a valid verdict.

## Before you respond

Read the request system prompt first: it carries the executor
contract - which op to prefer (patch for edits to existing files, full
content only for creates and wholesale rewrites) and the touch-set
rules for commands. The JSON Schema per-op descriptions carry the same
guidance.

The canonical loop for executor requests is compose, preflight,
respond:

1. Compose ops with `spc patch build` - chaining multiple edits to one
   file with `spc patch build --after <ops.json>`, never hand-typed
   digests.
2. Preflight the assembled draft with `spc agent dry-run <id> --file
   draft.json` - one command checks the schema, stages against the
   request's base revision (not the live tree), predicts apply-time
   refusals (write scope, protected paths) with the same enforcement
   apply uses, runs the task's deterministic criteria, and with
   `--gates` also runs the repo's declared test/build/lint/typecheck
   commands inside the worktree with real dependencies linked in. Fix
   everything it reports - including suite-did-not-run and PREDICTED
   REFUSAL lines - before responding. Every line is advisory; the
   run's verification remains the only authority.
3. Respond with `spc agent respond <id> --file draft.json`.

Never rehearse on the live tree: no hand-applied anchors, no
apply-gates-revert shell scripts. The dry-run worktree IS the
rehearsal - all-or-nothing, disposable, and visible in the queue
(`spc agent list` shows preflighted counts). An invalid answer costs a
round trip through the requeue-with-feedback loop. A requeued request
with feedback means your previous answer failed schema validation:
read the errors, fix the shape, do not change the substance unless
asked.

Answer exactly what is asked. Executor requests execute ONE task; do
not do the whole plan. Never claim a requirement is satisfied -
evidenceCandidates are informational; verification happens elsewhere.
Every file you changed must appear in `changes`; never report changes
you did not make.

## Composing patch answers

Never hand-type a patch op. Compose it with the tool that performs the
protocol mechanics:

```bash
spc patch build <path> --anchor-file a.txt --replacement-file r.txt
```

The command computes the baseDigest from the actual tree, verifies the
anchor occurs exactly once, and emits the complete op JSON - merge that
into your answer's `changes`. Extra flags that matter:

- `--expect-digest <sha256>`: pass the digest from the request's
  repositoryExcerpts entry; the command refuses if the tree moved since
  the request was built (composition-time optimism check, free).
- `--after ops.json`: when chaining multiple edits to one file, pass the
  ops composed so far; the new anchor is verified against the overlay
  and the digest chains.

A refusal here costs a command error, not a task retry - fix the anchor
and rebuild. Use file flags for exact bytes (trailing newlines included).
On commands that write files, declare a `touchSet` - undeclared writes
fail closed.

## Session hygiene

The answering session is one long conversation with a frozen prefix -
keep it that way. Start a fresh session per major run: compaction
rewrites history mid-session, which simultaneously destroys the cache
economics and summarizes away your early answers. If you feel the
context ceiling approaching, finish the current request, then start
clean and re-orient with one command - `spc brief` shows every spec's
last run and blocking follow-ups, the pending queue, and config
posture - rather than pushing through.
