# Spec authoring reference

A spec is a YAML file declaring desired state: what must be true of the
repository, how each claim is verified, and what is explicitly out of scope.
This page documents every field. For the workflow around specs, see
[Getting started](getting-started.md).

## File layout

One spec per file, under `specs/`. The full shape:

```yaml
apiVersion: spc.dev/v1alpha1
kind: Spec

metadata:
  id: oauth-login                # required, kebab-case, stable
  title: GitHub OAuth Login      # required
  description: Optional longer summary.

goal: >
  Users can sign in with GitHub OAuth without breaking password sign-in.

imports:                          # optional (see "Composition")
  - ./security-invariants.yaml

environment:                      # optional (see "Secrets")
  requiredSecrets:
    - GITHUB_CLIENT_SECRET

requirements:                     # required, at least one
  - id: AUTH-001
    statement: Users can sign in with GitHub OAuth.
    priority: must
    category: security
    dependsOn: []
    scope:
      include: [src/auth/**]
      exclude: [src/auth/legacy/**]
    acceptance:
      - id: AUTH-001-A
        type: command
        command: node --test "tests/auth/*.test.mjs"
        expect:
          exitCode: 0

constraints:                      # optional; default priority is must
  - id: AUTH-C01
    statement: OAuth tokens are never stored in plaintext.
    priority: must
    acceptance:
      - id: AUTH-C01-A
        type: file
        path: src/auth/tokens.ts
        assert:
          notContains: "localStorage.setItem"

outOfScope:
  - enterprise SSO
```

## metadata

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`). Referenced by plans, runs and branches. Never rename after runs exist. |
| `title` | yes | Human title used in rendered output. |
| `description` | no | Free text. |

## goal

Required. One or two sentences of intent. The planner and executor both
receive it, so write it for a competent engineer who has not read your mind.

## Requirements and constraints

Requirements and constraints share one property namespace and the same field
shape. The difference is intent: requirements describe features, constraints
describe invariants that must hold. Both are first-class desired properties;
both need coverage and verification when priority is `must`.

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$`, for example `AUTH-001`, `SEC-C01`. Unique across the composed spec, including imports. Never renamed. |
| `statement` | yes | The claim, in checkable language. Prefer "X returns Y" over "X is good". |
| `priority` | required for requirements; optional for constraints (defaults to `must`) | `must`, `should` or `may`. `must` requires acceptance criteria and a verification path; `should`/`may` without criteria compile with a warning (SPC1005). |
| `category` | no | One of `behavioral`, `security`, `performance`, `compatibility`, `operational`, `architectural`, `ux`, `compliance`. A tag that shapes planner context and rendering. A `must` property categorized `security` or `compliance` with no command or file criterion triggers warning SPC1009. |
| `dependsOn` | no | Property ids that must be satisfied first. Cycles are compile errors. Cross-file references are legal when using imports. |
| `scope` | no (requirements only) | `include`/`exclude` glob lists hinting where the property lives. |
| `acceptance` | required in practice for `must` | List of criteria; see below. |
| `metadata` | no | Free-form map; part of the digest. |

## Acceptance criteria

Four types, in decreasing order of evidence strength. Mix freely; the
satisfaction evaluator handles each type with its own epistemic rules.

### command - deterministic execution (strongest)

```yaml
- id: AUTH-001-A
  type: command
  command: node --test "tests/auth/*.test.mjs"
  expect:
    exitCode: 0        # optional, default 0
  timeoutMs: 120000    # optional, default from config
```

The runtime executes the command in the verification directory and records
exit code, stdout/stderr digests, redacted output excerpts and duration.
Commands are classified by policy (see
[Configuration](configuration.md)); approval-class commands produce an
approval follow-up instead of running (see
[Follow-ups and approvals](followups-and-approvals.md)).

### file - static file assertion

```yaml
- id: AUTH-C01-A
  type: file
  path: src/auth/tokens.ts
  assert:
    exists: true          # at least one of exists/contains/notContains
    contains: "encrypt("
    notContains: "localStorage.setItem"
```

Weaker than behavioral testing but cheap and deterministic. Good for
structural invariants.

### agent - model-derived review

```yaml
- id: AUTH-C02-A
  type: agent
  instruction: >
    Inspect token persistence and determine whether access tokens
    can be stored unencrypted.
```

A separate verifier invocation with independent context (never the
executor's own conversation). Evidence is always labelled as
model-derived. If it is the only support for a `must` property, status
stays `indeterminate` unless `verification.allowAgentOnlyMustRequirements`
is explicitly enabled.

### human - manual review

```yaml
- id: AUTH-C03-A
  type: human
  instruction: Confirm the OAuth consent screen reads acceptably.
```

Produces a non-blocking `manual_verification` follow-up and leaves the
property `indeterminate` until a human resolves it. Resolution becomes
human evidence.

## Identifier rules (why they are strict)

Identity and presentation order are separate concerns. Ids appear in plan
tasks, run states, evidence records, follow-ups and Git branch names;
renumbering or renaming breaks traceability with everything already
recorded. Hence pattern-enforced formats and uniqueness across the composed
spec, and hence SPC1008 rejecting id collisions between imported files
rather than silently namespacing them.

## Digests and staleness

Compilation normalizes the spec (defaults applied, set-like lists sorted)
and hashes it to `sha256:<hex>`. Identical logical content yields identical
digests regardless of key order or formatting. Plans record the spec digest
they were planned against; if the spec changes, `spc apply` refuses the old
plan (SPC2009). The digest covers composed imports: editing any file in the
import graph changes it.

## Composition (imports)

Shared invariants can live in one file and compose into feature specs:

```yaml
imports:
  - ./security-invariants.yaml
```

Rules:

- The importing file's metadata and goal define the composed spec; imported
  files are libraries.
- Requirements, constraints and out-of-scope entries merge, entry file
  first, then each import in declaration order, transitively.
- `dependsOn` may reference imported properties.
- Property id collisions across files are compile errors (SPC1008); ids are
  never rewritten.
- Import cycles are compile errors (SPC1006). Missing files: SPC1007.
- The digest covers the composed graph, so plans go stale when any imported
  file changes.

## Secrets

```yaml
environment:
  requiredSecrets:
    - GITHUB_CLIENT_SECRET
```

Presence-checked only, at apply preflight, before any model call is spent.
A missing secret blocks the run with a `missing_secret` follow-up. Values
are never read into specs, plans, prompts or persisted records. Declaring a
secret changes the digest, because it changes what the spec requires.

## Writing checkable statements

The spec is an executable claim list, not a user story board.

Good:

```yaml
statement: greet(name) returns "hello, <name>".
statement: Exported CSV quoting survives commas and quotes in values.
statement: p95 latency of /search stays under 300ms with 50 concurrent users.
```

Weak (compile, but verify nothing):

```yaml
statement: The auth module is clean and well designed.
statement: Performance is good.
```

If you cannot name an acceptance criterion for a `must` property, that is
the signal to either make the claim concrete or downgrade it to `should`
and accept the SPC1005 warning honestly.

## Rendering (never parsed back)

`spc spec show <file> --format markdown` renders documentation-grade
Markdown from the compiled spec, suitable for design review or a PR
description. Generated Markdown is a view only; canonical state is the
structured IR behind the digest.
