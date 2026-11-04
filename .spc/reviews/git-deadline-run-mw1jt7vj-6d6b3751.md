# adversarial review: git-deadline / run run-mw1jt7vj-6d6b3751

Target: spec git-deadline (digest sha256:ee716e27...), run run-mw1jt7vj-6d6b3751,
commit range d30cef5..caa475c0 plus the between-runs R1 strengthening op.

## pass 1 — reviewer (subagent, adverse-review, RAM-constrained)

Verdict: PASS, zero contract violations. All nine probes exonerated,
analytically and empirically against the shipped dist:

- timedOut definition exact (status null AND ETIMEDOUT); the
  slow-collect edge probed live (child exits 0, grandchild holds pipes):
  classified ok=true, timedOut=false - no misclassification in either
  direction.
- Ordinary-failure paths byte-identical by construction; timeout results
  ok:false.
- gitOk throw ordering (SPC_GIT_DEADLINE before SPC_GIT_ERROR); message
  names command + budget + index.lock hint (probed).
- Env parsing: unparsable/""/0/negative/Infinity -> default; floats
  floored; no path to a sub-1ms budget; never disableable.
- Three sibling routings semantics-preserving (timeout degrades to each
  site's existing failure path); spawnSync imports removed; verifier's
  @spc/repo routing green (verify-cache 9/9).
- gitBinary threads through git() and gitOk(); killSignal SIGKILL
  hardcoded - no option weakens it.
- Empirical: SIGTERM-trapping fake killed at 304ms (vs 20s trap sleep),
  named error surfaces exact; real git 33ms, ok=true.
- Oracle discriminates honestly (elapsed <10s cannot pass with a naive
  SIGTERM implementation; red-first provenance at d30cef5).
- Repo-wide sweep: no other git spawns outside the adapter (taskkill and
  pnpm installs excepted by contract).

Finding GDL-R1 (low, test-strength): the GD-002 source check matched a
single literal quoting form in three named files.

## rectification — fixer (main agent), between-runs patch leg

GDL-R1: the check broadened to /spawnSync\(["']git/ (quote-variant
proof). Oracle 3/3 green after.

## result — proved by spc verify

- Standalone spc verify specs/git-deadline.yaml: GD-001/002/003 all
  satisfied, exit 0.
- Run battery green in-run (GD-003-A satisfied in the run itself - no
  flake this time).
- Orphan sweep after run completion: clean.

Operational note for the record: the FIRST execution of this plan
(run-mw1jaifu) died mid-task with six orphaned vitest workers (ppid=1)
- the machine's known RAM pressure class. Orphans killed, workspace
recovered via spc apply recover (clean), plan re-applied, second run
succeeded. The friction gate also correctly refused a raw respond
without a matching preflight; the dry-run-then-respond discipline
resolved it. Sign-off: main agent, after proof.
