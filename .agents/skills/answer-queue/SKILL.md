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

Validate the draft against the response schema locally first - an
invalid answer costs a round trip through the requeue-with-feedback
loop. A requeued request with feedback means your previous answer failed
schema validation: read the errors, fix the shape, do not change the
substance unless asked.

Answer exactly what is asked. Executor requests execute ONE task; do
not do the whole plan. Never claim a requirement is satisfied -
evidenceCandidates are informational; verification happens elsewhere.
Every file you changed must appear in `changes`; never report changes
you did not make.

## Session hygiene

The answering session is one long conversation with a frozen prefix -
keep it that way. Start a fresh session per major run: compaction
rewrites history mid-session, which simultaneously destroys the cache
economics and summarizes away your early answers. If you feel the
context ceiling approaching, finish the current request, then start
clean and re-orient from `.spc/` state rather than pushing through.
