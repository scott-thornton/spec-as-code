# adversarial review: per-request-budget / run run-mw5ey1hx-69db8b39

Read-only pass (RAM discipline). Verdict: PASS with nits, no must-level
violation. All 12 config-x-request control pairs traced: pre-change
shape or pre-fetch PROVIDER_CONFIG refusal, never an invalid wire body;
byte-shape without overrides intact; streaming shares the body
construction (no divergence); StructuredRequest purely additive (no
enumeration consumers).

Findings: F1 LOW stale-config guard refuses a coherent overridden pair
(conservative, kept); F2 LOW remediation lever list named only provider
levers when the REQUEST drove the budget - FIXED (the remediation names
the request lever when request-level); F3 LOW oracle does not pin
pre-fetch ordering (validation-absence IS pinned); F4/F5 INFO ordering
mask + spec-phrase nit.

Proof: oracle 4/4 after the F2 fix (single-file run). PRB-002 battery
CI-owned (in-run contradiction = known flake class).
