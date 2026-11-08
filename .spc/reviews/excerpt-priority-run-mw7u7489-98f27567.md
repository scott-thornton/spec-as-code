excerpt-priority / run run-mw7u7489-98f27567. Full in-run success
(all four properties). Read-only adversarial pass: PASS with
low-severity findings.

- XP-F1 LOW rectified: existsSync alone admitted DIRECTORIES as
  explicit "files" (bare-directory read targets would claim excerpt
  slots as empty excerpts). FIXED: statSync().isFile() gate; oracle
  leg added (a declared dir claims no slot).
- XP-F2 LOW rectified: over-cap explicit (>8) behavior unpinned.
  FIXED: oracle leg (sorted, first cap; globs get nothing).
- XP-F3 INFO: control leg breadth (single-glob; identity proven by
  construction regardless).
- XP-F4 INFO: backslash-spelled targets (schema-legal) no longer
  normalized before classification - exotic, unreachable through
  validated plans.
- XP-F5 RECORDED (different defect, same class, out of scope):
  observer.ts relevantArtifacts orders via localeCompare (locale/
  ICU-dependent) and planner prompts take first 6 - a cross-platform
  prompt-stability hazard on a surface this spec did not cover.
  Future spec.

Exonerations: metachar superset-safe; byte-identity of the no-explicit
case PROVEN (empty-explicit degenerates to identity re-sort of
listMatchingFiles output); blast radius exactly one call-site line;
determinism end-to-end (code-unit sort both sides, walk sorts
traversal); blast-radius sweep found no other capped excerpt union
(redispatch reuses the fixed prompt; touchset/lint consumers
single-pattern; planner excerpts are a different heuristic with no
declared-target union).

Proof: oracle 8/8 post-rectification (fresh build, cache invalidated
by patch-fresh-build - dogfooded); standalone spec verify exit 0.
