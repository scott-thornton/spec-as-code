executor-prompt-update-op / run run-mw5n4353-5ae36379. EPO-001 satisfied
in-run; EPO-002's battery caught a REAL violation: the first teaching text
included a literal braced JSON example, breaking prompt-stability PST-003
(no braces in the constant role system - prefix-cache stability).
Rectified via patch leg: brace-free phrasing (op: "update", with the path
and the full content). Both oracles green (5/5 across
executor-prompt-update-op + prompt-stability); spec verify exit 0. The
battery did exactly its job - the in-run contradiction was a true red, not
the flake class. Self-review proportional (one prompt block; the
prompt-stability oracle IS the adversarial pass for this surface).
