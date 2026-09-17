# bookmark-service - a standalone spc example

A small, realistic service (in-memory bookmarks, a documented public export
API) and a feature spec a senior engineer might actually write: add tags +
tag filtering and RFC-4180 CSV export **without breaking the existing
`exportJson()` contract**.

## Run the loop

```bash
pnpm build                                  # in the monorepo root
GLM_API_KEY=… examples/bookmark-service/run-demo.sh [model]
```

The script copies this directory to a temp git repo and runs validate →
plan → apply → status → diff → `run pr`, printing everything. The full
captured transcript with commentary is in [TRANSCRIPT.md](TRANSCRIPT.md).

## Layout

- `src/`, `tests/` - the service (pre-feature state, suite green)
- `specs/bookmarks-tags-csv.yaml` - the desired state
- `.spc/config.yaml` - provider (Anthropic-compatible GLM endpoint),
  `parallelism: 2` (the two writers are disjoint - ADR-0012), clarification
  demotion on (ADR-0013)
