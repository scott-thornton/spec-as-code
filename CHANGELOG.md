# Changelog

## Unreleased

### Changed
- **`spc status` now renders the effective chain state by default.** When a spec's runs form a validated chain (`parentRunId` links), status shows the chain-head run's persisted requirements — which already encode inherited provenance — with a provenance breakdown (newly satisfied / inherited / unresolved). The exit code reflects the effective verdict: a spec whose latest run is partial but whose chain is complete now exits 0. Use `--run <id>` for the previous single-run view. This is a CLI compatibility change for anything scripting against `spc status` exit codes.
- **`spc run pr` leads with the chain verdict** for chained runs: linked-run count, combined must satisfaction, per-run contribution, and an explicit note when chain evidence includes revisions not contained in the PR branch (cumulative verdict and diff are different claims).

### Added
- **`parentRunId` on apply runs** — validated chain lineage recorded at creation: the default parent is the latest prior apply run of the same spec digest whose committed result is a git ancestor of this run's base. Chronology is not causality; two independent runs never link. `spc apply --parent <runId>` sets it explicitly with the same validation.
- **`spc brief` shows chain depth** for specs with continuations (`· N runs (chain)`).
