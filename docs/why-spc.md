# Why spc

The honest pitch, including what it does not do for you. Read this before
the guides.

## The problem

A normal coding-agent session conflates four different things: what you
wanted, what the agent intends to do, what it actually changed, and whether
the result works. The plan is prose in a chat, the edits land directly in
your working tree, and "done" is the agent's own assertion. If it drifts to
a file you never mentioned, you find out in review - if you review
everything. Three weeks later, "why is this line like this" has no answer
except scrolling a transcript.

spc separates those four things into artifacts with rules attached: a spec
(what you wanted), a validated plan (what will happen), a bounded execution
(what happened, inside a fence), and evidence (why the system believes it
worked).

## What you get today that a plain agent session does not give you

1. **A physical fence.** Each task declares its write targets, and the
   runtime enforces them against the real Git diff - not against what the
   agent claims it touched. A task that says `src/auth/**` cannot modify
   `package.json`. Violations fail the task and are recorded. This holds
   regardless of model quality because it is enforced by code, not by the
   model's good behavior.

2. **"Done" means proof.** A requirement is marked satisfied only when its
   acceptance criteria actually ran - command exit codes, file checks -
   recorded with output digests and timestamps. The agent's self-report is
   informational only. Receipts are append-only; contradictory evidence is
   never deleted.

3. **Your working tree stays untouched.** Every run executes in its own Git
   worktree on its own branch. Rollback is deleting a branch. Nothing merges
   or pushes without you.

4. **It blocks instead of guessing.** Missing spec detail, missing secret,
   ambiguous requirement: you get a structured follow-up with options, not a
   confidently invented decision baked into code.

5. **Replay without transcripts.** Runs are append-only event logs. A second
   engineer - or you, later - can reconstruct what ran, in what order, with
   what evidence, without reading a chat.

6. **Specs do not rot silently.** `spc verify` re-runs your acceptance
   criteria after manual changes, rebases or upgrades; `spc reconcile`
   plans the correction when reality has drifted. The spec stays a live
   invariant instead of becoming stale documentation.

7. **Your existing agent, inside the fence.** The harness provider lets the
   coding agent you already use answer spc's planning and execution
   requests through files. Its answers then pass through the same
   validation, write enforcement and verification as any other provider.
   Note on cost: this is not free - the tokens are billed to that agent's
   existing subscription or key (and an exploring agent can spend more than
   a direct API call would). The benefit is zero setup and guardrails on
   your existing agent, not savings.

## What it does not give you

Honesty section, not a disclaimer section:

- **Speed.** There is more ceremony than "agent, go". On the benchmark
  corpus (30 small tasks) a competent agent completes everything through
  either workflow, so the ceremony buys nothing measurable there and costs
  nothing measurable either. Where the fence and the receipts should pay
  off - larger repositories, real drift risk, constrained changes, audit
  requirements - remains unmeasured, and is the open question this project
  exists to answer.
- **A better model.** spc is not smarter than the agent you already use.
  It is the same intelligence with boundaries and receipts.
- **Autonomy without you.** Approvals, waivers, merges and ambiguous calls
  come back to you by design. If you want fire-and-forget, this tool will
  frustrate you.

## Use it when

- The agent could plausibly break something you did not ask about
  (lockfiles, public APIs, migrations, infra).
- "Is it actually done?" needs an answer better than "the agent said so" -
  for your own discipline, a teammate, or an auditor.
- You will need to explain the change later: what was required, what was
  planned, what was run, what evidence exists.
- The requirements are real and stable enough to write down once and
  re-verify forever (regression suites, security invariants, API
  compatibility promises).

## Skip it when

- The task is trivial and you review every line anyway.
- You fully trust the agent and the stakes are low.
- "It compiles, ship it" is genuinely the bar.

## The bet

Intelligence at the edges, deterministic state in the middle: the planner
and executor can be probabilistic (any model, any provider, even a human),
while requirements, dependency graphs, permissions, lifecycle, evidence and
satisfaction status stay deterministic and inspectable. Whether that
structure earns its overhead is an empirical question - the benchmark
harness in [evals/](../evals/README.md) exists so the answer is measured,
published, and iterated on rather than argued about.
