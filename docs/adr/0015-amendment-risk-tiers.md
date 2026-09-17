# ADR-0015: Computed amendment risk tiers

Date: 2026-09-17
Status: accepted

## Context

§31 defines three amendment approval tiers (low: auto-continue; medium:
continue if no spec or public-API change; high: require human approval). V0
implemented only an implicit "always auto" plus the clarification-demotion
flag (ADR-0013) - the tier was never computed from the amendment itself.

## Decision

`execution.amendmentApproval: "auto" | "tiered"` (default `auto`, preserving
existing behaviour). Under `tiered`, `classifyAmendmentRisk` computes risk
from the amendment's **operations**:

- **high** - any introduced task declares `risk: "high"` or writes a
  high-risk path (dependency manifests/lockfiles, migrations, Dockerfiles,
  compose files, CI workflows, infra/terraform/k8s; extendable via
  `execution.highRiskWritePatterns`). The amendment is *not applied*: it is
  preserved as `<AMENDMENT>.gated.json` in the run directory, a blocking
  `approval` follow-up is raised describing operations and reasons, and the
  run finishes `blocked`.
- **medium** - structural changes (remove/replace/changeTarget, or adding
  write-capable tasks) that touch no high-risk paths: continue (the planner
  cannot mutate the spec, so "no spec change" always holds; "no public API
  change" is proxied by the high-risk pattern list).
- **low** - dependency-only or read-only additions: continue.

Public-API detection is deliberately a *path proxy*, not semantic analysis:
cheap, predictable, and over-approximating toward caution.

## Consequences

- High-risk rewrites (dependency replacement, migrations, deployment config)
  get a human checkpoint without a policy language.
- Gated runs keep everything inspectable: amendment JSON, follow-up, events.

## Alternatives considered

- Asking the replanning model to self-declare risk: self-report is exactly
  what this system refuses to trust elsewhere.
- A general policy engine: rejected by the plan (§74) for V0 and unnecessary.
