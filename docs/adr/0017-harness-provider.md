# ADR-0017: The harness provider

Date: 2026-09-17
Status: accepted

## Context

Coding-agent harnesses (ZCode, Claude Code, IDE agents) already have a
competent model with repository access in the loop. Two integration needs
exist: (a) harness agents driving the CLI need machine-readable output, not
scraped text; (b) for users without an API key - or who want the harness
agent itself to be the intelligence - spc's model calls should be answerable
by that agent instead of a vendor endpoint.

## Decision

1. **JSON output mode** (`--format json`) on spec validate, plan show,
   verify, status, diff, followups and agent list: stable field names, one
   shape per command, designed for programmatic consumption.
2. **`provider: harness`** (new `@spc/llm-harness` package): each structured
   request is written to `.spc/harness/pending/<id>.json` with the system
   prompt, bounded context, and the exact JSON Schema (rendered from the
   same zod schema all providers validate against). The provider polls for
   `.spc/harness/answered/<id>.json` (1 s interval, configurable timeout,
   typed timeout error). Answers failing schema validation are requeued
   with the validation errors and prior answer attached, keeping the same
   request id; valid answers clear the pending file and are retained in
   `answered/` as the decision record.
3. **`spc agent list|show|respond`** operate on the same directory: the
   harness-side half of the contract. `respond` takes a file (or stdin)
   containing the JSON value itself.
4. Request ids are `<role>-<key>-<invocation>` with stable keys
   (`planner@<attempt>`, `T001@<attempt>`, `<taskId>@<attempt>` for
   replanning, `<propertyId>:<criterionId>` for agent verification), so
   harnesses can watch `agent list --format json` and answer with no other
   coupling.

The file protocol is the entire integration surface: spc never spawns,
hooks or prompts the harness process. All spc guardrails (plan validation,
write-scope enforcement from the real Git diff, evidence, replayability)
apply to harness answers unchanged - the guardrails are the point.

## Consequences

- Any agent that can read and write files (or a human with an editor) can
  serve as planner/executor with zero API spend.
- The waiting process blocks up to `harnessResponseTimeoutMs`; for very long
  deliberation, raise the timeout - or let it time out and rely on the
  existing retry/resume machinery.
- answered/ grows monotonically; it is an audit trail, and lives under the
  gitignored `.spc/` runtime state.

## Alternatives considered

- Spawning the harness CLI headlessly per request: couples spc to each
  harness's CLI/auth/sandbox and inverts who owns the loop.
- MCP server now: heavier surface; the CLI + JSON output serves harnesses
  that can run shells, and the same operations map onto MCP tools later if
  tool-native integration earns it.
- Answering via follow-ups: follow-ups are the human-decision queue; model
  requests are a different lifecycle (timeout + retry vs. resolve-once),
  and conflating them would muddy both.
