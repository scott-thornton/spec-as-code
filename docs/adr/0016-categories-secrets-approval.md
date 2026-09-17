# ADR-0016: Requirement categories, command approval, secret references

Date: 2026-09-17
Status: accepted

## Context

Three plan features were specified but unbuilt: §80 higher-order requirement
types, §52 approval-class commands, and §53 named secret references.

## Decisions

**Categories (§80).** Requirements/constraints gain an optional `category`
(behavioral, security, performance, compatibility, operational,
architectural, ux, compliance). It is *metadata that shapes behaviour*, not
a second verification machinery: the four acceptance criterion types remain
the only verifiers. Concretely it flows into planner/executor context,
status/PR/spec rendering, and one compiler warning - SPC1009: a `must`
property categorized `security`/`compliance` with no command/file criterion
deserves deterministic verification. The plan's warning ("do not bake an
exhaustive taxonomy into V0") is honored: no category-specific executors.

**Command approval (§52).** Approval-class acceptance commands (installs,
migrations - per the command policy categories) no longer fail silently as
"inconclusive: denied". They now produce an `approval` follow-up carrying
the exact command; resolving it with `--option approve` allowlists that
exact command string for verification, which then runs it (deny-class
policies are unaffected by approvals). Approval is per-command-string, not
per-category - approving `npm install --dry-run` approves nothing else.

**Secret references (§53).** Specs may declare
`environment.requiredSecrets: [NAME]`. Presence-checked only: `spc apply`
preflight raises a blocking `missing_secret` follow-up for any that are
unset; values are never read into specs, plans, prompts or persisted
records (redaction already covers command output). Declaring a secret
changes the spec digest - changing requirements *should* invalidate plans.

## Consequences

- High-assurance categories nudge authors toward deterministic evidence
  without forcing a taxonomy.
- Approval-gated commands keep the deny-by-default posture while becoming
  usable; the human decision is an event and a follow-up, not prose.
- Secret names are safe to commit; their absence is caught before any
  model call is spent.

## Alternatives considered

- Category-specific verifier plugins: premature machinery for V0.
- Approving command *categories*: too broad - one approval would unlock a
  class of commands.
- Reading secret values into an env template for executors: the executor
  runs in the user's environment already; persistence safety argues for
  never touching values.
