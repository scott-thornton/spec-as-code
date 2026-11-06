timer-hygiene / run run-mw5iigku-0f46205f. Run SUCCEEDED fully in-run
(NT-002-A battery green inside the run). Diff is two lines (store
raceTimer; clear in the existing finally) - proportional self-review per
the brief-json-contract precedent: verified the finally is the
non-streaming path's exit for ALL outcomes, the streaming stall timer
was already cleared (exonerated at review time), timeout semantics
untouched (the race promise itself is unchanged; only its timer's
lifespan after completion). Oracle measured the defect exactly (8222ms)
and pins the fix (<4s bound, generous margin).
