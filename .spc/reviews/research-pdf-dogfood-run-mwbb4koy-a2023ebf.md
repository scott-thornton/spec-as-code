# adversarial review: research-pdf-dogfood / runs run-mwba6td2, run-mwbb4koy

The parallel experiment: a stand-alone NON-CODE git repository
(manuscript, recorded data, a handcrafted minimal PDF, pure-fs check
scripts, a three-criterion spec) running the ordinary spc loop end to
end through the existing CLI - init on the real substrate, spec
validate, verify, plan and apply via the fake provider's scripted
YAML (disclosed in the spec: the pipeline around the model is what
the experiment exercises), status. Three defect classes distinguish
(source-content vs stale-PDF vs layout), and an undeterminable render
refuses to fabricate a visual verdict by outliving the command budget
- budget-timeout, indeterminate through the existing family.

The generality hypothesis HELD: zero core changes, no new artifact
types, no domain-specific evidence status; the write-scope, patch-op,
deadline, and ownership machinery is path-and-command shaped and
operated on manuscript.md and paper.pdf exactly as on source files
(the reviewer verified the scripted changes flowed through
enforceWriteScope, safe-path checks, the unmediated-change guard, and
stageChanges - no applicator bypass).

Pass 1: NEEDS-RECTIFICATION with an F1 that belongs in the museum:
every green pin used /satisfied.*RPF-x/ - which "un+satisfied"
satisfies - so a both-red world passed the experiment's
distinguishability matrix. The machine's own false-green class, found
in the experiment built to test the machine. Rectified: row-anchored
pins with explicit not-unsatisfied guards, evidence-side green pins
(pdf corresponds: 42 / source consistent: 41), variant D's asymmetry
made visible (corrupt bytes fabricate a red one criterion over -
correspondence-check exits 1 on undeterminable input; the principled
refusal belongs to the layout check, not the kernel - pinned as
unsatisfied with its evidence), the scripted-provider disclosure
amended into RPDF-001, spc init run on the fixture substrate, C01
pins extended (node:http/dns/undici banned, provider.name: fake
pinned), leak check deepened, dead helper removed.

Confirmation: the 12/12 local re-run under the anchored pins IS the
confirmation for this rectification - the F1 was precisely "a both-red
world passes", and the strengthened pins fail that world by
construction; a third read-only pass over oracle regexes adds nothing
the re-run does not. Deliberate scope call, recorded here.

Run history: run-mwba6td2 (all five satisfied - the experiment; the
fixture landed byte-identical to the locally verified 12/12 content,
corpus pattern), run-mwbb4koy (all five satisfied across the
disclosure amendment's digest fork via synthesized flips - the
fork-fix dividend again).

RECORDED NOT TAKEN (bounded): the regen is a text content op, not an
executed renderer - binary-artifact mutation through command-shaped
writes is undemonstrated (the spec's outOfScope covers it); the
fixture's spc() spawns with cwd rather than the named --cwd flag
(same resolution path; recorded); the C01 network ban is a regex, not
a sandbox; variant D's layout-check budget consumes 2x8s wall per
verify (the retry-once rule - deterministic, disclosed timing).
