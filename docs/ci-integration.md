# CI integration (§81)

`spc verify --format github` turns a pull request into a partially
requirement-oriented review: unsatisfied must-properties become CI error
annotations, indeterminate and non-must failures become warnings, and a
Markdown summary lands in the GitHub step summary.

## Example workflow

```yaml
# .github/workflows/spc-verify.yml
name: spc-verify
on: [pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Verify spec satisfaction
        run: node /path/to/spc/packages/cli/dist/main.js verify --format github
```

What happens:

- acceptance criteria run against the checked-out tree;
- each unsatisfied must-property emits `::error title="spc: <ID> <status>"::…`
  (annotations appear on the PR);
- the job summary table shows every property, its priority, observed state and
  evidence count;
- `human`/`agent` criteria surface as indeterminate warnings rather than
  silently passing — the PR shows exactly which claims await human judgment.

Notes:

- Commands are still policy-gated in CI (network/publish/push denied by
  default), so verification cannot become a deployment vector.
- For drift over time, run `spc reconcile` (without `--apply`) on a schedule:
  it reports which desired properties the current revision no longer
  satisfies and proposes the next transition plan for review.
