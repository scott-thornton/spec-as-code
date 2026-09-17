# Running spc through an agent harness

A harness is any agent that can run shell commands and read files in your
repository: ZCode, Claude Code, Cursor, or a human following instructions.
spc supports two integration models, and they compose.

## Model 1: the harness drives the CLI

The harness agent runs spc commands as ordinary shell commands and parses
machine-readable output. Every read command has a `--format json` mode with
stable field names:

```bash
spc spec validate specs/feature.yaml --format json
spc plan show --format json
spc verify --format json
spc status --format json
spc diff --format json
spc followups --format json
spc agent list --format json
```

Example `spc status --format json` (trimmed):

```json
{
  "spec": { "id": "greeting-api", "title": "Greeting API", "digest": "sha256:..." },
  "run": { "id": "run-ab12", "status": "succeeded", "resultRevision": "1c66471" },
  "properties": [
    {
      "id": "GREETING-001",
      "kind": "requirement",
      "priority": "must",
      "statement": "Calling greeting returns \"hello\".",
      "status": "satisfied",
      "evidence": [{ "id": "EV-0002", "kind": "test", "outcome": "supports" }]
    }
  ],
  "tasks": [{ "status": "completed", "count": 2 }],
  "followups": []
}
```

A harness workflow in this model: the agent writes the spec with you, runs
`spc spec validate`, runs `spc plan` (which needs a model provider), then
`spc apply`, and reports `spc status --format json` back. Deterministic
commands (validate, verify with command/file criteria, status, diff,
follow-ups) also work with `provider.name: none` - no API key needed.

## Model 2: the harness IS the provider

The deeper integration: the coding agent becomes spc's model backend. Set:

```yaml
provider:
  name: harness

execution:
  harnessResponseTimeoutMs: 900000   # 15 min per request
```

Now spc makes no API calls. Whenever it needs a model response (planner,
executor, replanner, agent-verifier), it writes a structured request to
`.spc/harness/pending/<id>.json` containing the full prompt, the repository
context, and the exact JSON Schema the answer must satisfy - then waits (it
polls once a second) for an answer file.

The harness side uses three commands:

```bash
spc agent list                 # pending requests: id, role, schema
spc agent show <id>            # the full request: system, prompt, jsonSchema
spc agent respond <id> --file answer.json
```

`answer.json` contains the JSON value itself (not a wrapper). spc validates
it against the same schema every other provider uses; an invalid answer is
requeued into `spc agent list` with the validation errors and the prior
answer attached, so the agent can retry within the timeout window. Valid
answers are kept forever in `.spc/harness/answered/` as the record of who
decided what.

### What this buys you

Every spc guardrail applies to the harness agent's answers unchanged:

- plans are deterministically validated (coverage, cycles, write conflicts)
  before anything executes;
- executor writes are checked against declared targets from the actual Git
  diff, not the agent's claims;
- verification and evidence are runtime-owned;
- the whole loop is replayable from the event log.

The harness agent gets full repository access to answer requests (that is
its job), while spc keeps the deterministic middle. The request prompts
already contain the bounded context (spec excerpt, task, allowed paths,
repository excerpts), so a harness agent can answer them without reading
the entire repository.

### A worked session (ZCode-style)

Terminal 1 (or a background task):

```bash
spc plan specs/greeting.yaml
# blocks: "harness request planner-planner@1-1 pending"
```

Terminal 2 (the harness agent's session):

```bash
spc agent list
# planner-planner@1-1  [planner]  PlannerOutput
spc agent show planner-planner@1-1   # read prompt + jsonSchema
$EDITOR plan-answer.json             # author the plan JSON
spc agent respond planner-planner@1-1 --file plan-answer.json --by zcode
```

Terminal 1 continues automatically within a second, validates the plan, and
persists it. `spc apply` works the same way: one request per model-needing
task (executor keys look like `executor-T001@1-1`), deterministic verify
tasks never ask the agent at all.

A harness automating this loop watches `spc agent list --format json` and
responds whenever the array is non-empty - that is the entire integration
surface.

### Request ids

`<role>-<key>-<invocation>`, for example `planner-planner@1-1`,
`executor-T001@1-2` (second attempt), `replanner-T002@1-1`,
`verifier-AUTH-001:AUTH-001-A-1`. Keys are stable per role and task, so an
agent can anticipate what comes next; the invocation number separates
retries and repair rounds.

## Skill packaging for harness agents

Strictly, no skill is required: the file protocol plus `--format json` is
the entire contract, and any agent that reads the docs can drive the loop.
In practice you want the harness to already know the loop, without a human
pasting documentation each session. That is what the bundled skill is for:

```text
.agents/skills/spc/SKILL.md
```

It encodes the full agent playbook: when to prefer the spc loop over direct
editing, the command sequence, the `spc agent` response protocol, how to
read JSON status, and the hard rules (never edit run records, never widen
write scopes, never self-certify requirements, never merge the run branch).
Harnesses that discover skills (ZCode checks `<project>/.zcode/skills/`,
`<project>/.agents/skills/`, then the home-directory equivalents) pick it up
automatically. To use it in another repository, copy the directory:

```bash
cp -r .agents/skills/spc <target-repo>/.agents/skills/   # per-repo
cp -r .agents/skills/spc ~/.agents/skills/               # personal, everywhere
```

## Choosing a model

- **Harness provider** when a coding agent is already in the loop: the agent
  answers with full repo context, you spend zero API tokens, and every
  answer is guardrailed and recorded.
- **API providers** (openai/anthropic adapters) for unattended runs, CI, or
  the benchmark harness.
- **Fake provider** for deterministic tests and rehearsal.
- `provider: none` when you only want the deterministic half (validate,
  verify command/file criteria, status, diff, follow-ups).

## What is deliberately absent

- spc never spawns or prompts the harness itself: no daemon, no hooks into
  the harness process. The file-based protocol is the entire contract, so
  any agent (or human) that can read and write files can participate.
- No MCP server yet: the CLI plus JSON output covers the same ground for
  harnesses that can run shells. If a tool-native integration becomes
  valuable, the same operations map directly onto MCP tools.
