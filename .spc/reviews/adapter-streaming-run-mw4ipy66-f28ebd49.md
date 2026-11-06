# adversarial review: adapter-streaming / run run-mw4ipy66-f28ebd49

Target: spec adapter-streaming (digest sha256:6b241c29...), run
run-mw4ipy66-f28ebd49, range 97ac282..b364c75 plus between-runs
rectification ops.

## pass 1 - reviewer (subagent, RAM/disk-disciplined)

Verdict PASS, no contract violations; every probe exonerated with
citations + empirical confirmation (split-event parse, multi-block join
parity, stall abort at ~301ms with clean process exit, partial-discard
across all seven early exits, non-streaming byte-identity, shared HTTP
mapping on both paths).

Findings:
- F1 Medium (oracle gap): no long-generation leg - total duration
  exceeding timeoutMs with steady deltas must COMPLETE; only the stall
  aborts. Discriminates total-wall implementations behaviorally, not
  just by message wording.
- F2 Medium (oracle gap): chunk-boundary stress (multi-events per read,
  mid-event splits, two text blocks joined with newline) never
  exercised; reviewer probed the implementation passes all three.
- F3 Low: no break on message_stop - a lingering gateway could convert
  a complete answer into a stall timeout.
- F4 Low: cache usage fields arrive in message_start.usage on the real
  wire (spec named message_delta only) - streaming reported undefined
  where non-streaming reported values.
- F5 Info: CRLF streams would not split (Anthropic uses \n; noted).
- F6 Info (pre-existing, out of range): the non-streaming timeoutRace
  inner timer is never cleared - the process lingers timeoutMs after
  completion. Follow-up candidate; not this diff.
- F7 Info (flake vector): the in-run battery's old-adapter-signature
  failure of streaming tests is explained by a stale sibling dist
  (@spc/llm dist lacking the new export - the import goes undefined)
  under the same window as a transient DISK-FULL event truncating a
  dist write. No code nondeterminism in the diff. Known flake class;
  the failure-classification spec (backlog) gains another exhibit.

## rectification - fixer (main agent), between-runs patch leg

- F3: break on message_stop (complete answers cannot become timeouts)
- F4: cache fields captured from message_start too (message_delta wins
  if it re-states them)
- F1: ST-002b leg - generation longer than timeoutMs, steady deltas,
  completes (a total-wall impl cannot pass)
- F2: ST-001b leg - packed/split chunks across awkward byte boundaries,
  two text blocks, newline join parity
- F5/F6: recorded, not changed (CRLF not on the wire; F6 pre-existing)

## result - proved by spc verify

- streaming oracle: 8/8 (6 original + 2 adversarial legs)
- llm-anthropic suite: 33/33
- spc verify specs/adapter-streaming.yaml: all satisfied, exit 0
- spc verify --all: exit 0
- In-run ST-005 contradiction was the F7 environment class (standalone
  battery green twice, spec verify green, full verify --all green).
  Sign-off: main agent, after proof.
