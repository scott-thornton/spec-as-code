# Threat model

spc governs negligent agents; it does not contain malicious ones. Every
guarantee below is stated against that sentence, and any description of
spc that implies more is wrong.

## The model

**Trusted** (a compromise of these is outside this threat model):

- the spc runtime and its deterministic validation
- Git itself (object storage, content addressing)
- the verifier implementation and acceptance criteria as authored
- the approval mechanism (the human resolving follow-ups)
- the repository's `.spc/config.yaml` policy

**Untrusted** (all claims about these are checked, never assumed):

- planner output (validated before it executes anything)
- executor output (write-scoped, diff-checked, never self-certifying)
- model self-reports of success (evidence or it did not happen)
- generated tests and oracles, unless protected
  (`verification.protectedPaths`)
- command stdout/stderr (recorded, redacted, treated as data)
- repository code under modification

## What the mechanisms actually are

**Write scopes are not an operating-system sandbox.** They constrain
repository changes made through spc's mediated execution path
(structured response changes) and detect ordinary out-of-scope
Git-visible changes from any source, reverting them. Writes to
gitignored paths, writes outside the worktree, `.git`-level tampering
and other process-level effects are invisible to this mechanism.

**Command policy is a guardrail, not a boundary.** Classification is
deterministic pattern matching over the command string; it catches
accidental high-risk operations (`curl`, package installs, destructive
git) and is not designed to resist adversarial command construction -
interpreters, encoding, and unrecognized commands can bypass it.
`spc policy explain <command>` shows exactly what will match and why.
An agent that works to bypass classification makes itself conspicuous
in the command log; that conspicuousness is a feature, not a failure.

**The audit trail detects corruption; git-anchored attestations resist
log-only forgery.** Evidence records carry content digests and loads
verify them; a malformed line is a loud error, not a silent omission;
events are hash-chained, so editing, inserting, deleting or reordering
any event breaks the next event's pointer; and every run completion
writes a prefix attestation (`spc run replay` verifies all of it).
Digests and chains are computed by the same process that writes them,
so an attacker with write access to the log can recompute coherently -
the answer to that class is anchoring the chain heads in Git history
(`verification.attestInGit`), which an attacker who cannot rewrite git
history cannot forge. Protection against an attacker who CAN rewrite
git history is signatures/transparency, deliberately not built.

**Specs are executable configuration.** An acceptance criterion of type
`command` is a shell command the verifier will run. Trusting a spec
means trusting code, exactly like trusting a CI workflow file - and
untrusted spec content must never execute without human review, both
for what its criteria run and because spec text is injected into the
answering model's context (prompt injection surface).

## The graded posture

- **Accidents** (the empirically dominant failure mode): fully covered -
  scope enforcement, command guardrails, evidence-based completion.
- **Casual malice** (habitual, not targeted): mostly stopped by
  friction; the lazy attack is the denied one.
- **Competent malice** (deliberate, with shell access): not prevented.
  It is made expensive, conspicuous (the command and event logs), and -
  for repository damage - reversible (run-branch isolation, base
  revisions, violation reverts). Machine-level damage outside the
  repository is out of reach of every spc mechanism.
- **The operator who owns the machine**: permanently out of scope. No
  tool protects a system from the party that controls it.

Process-level containment (sandboxed command execution with policy
enforced at the boundary) is the known upgrade path for the third tier.
It is deliberately not built: it is a deployment dependency, not an
architecture change, and it will arrive under the same typed config -
`network: deny` should come to mean the namespace has no network
adapter, without changing a single line users wrote.
