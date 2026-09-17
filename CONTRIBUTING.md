# Contributing

Thanks for considering it. This repository is developed with coding agents
in the loop, so the contributor rules are written for agents and humans
alike - everything below is binding either way.

**Read [AGENTS.md](AGENTS.md) first.** It covers the commands, the package
map and the hard rules (deterministic tests only, no network in CI, no
secret values anywhere, append-only run records, ADRs for material
decisions). The summary:

## Ground rules

- MIT licensed; contributions arrive under the same license.
- `pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm test`
  must pass from a clean checkout before any PR. CI runs the same.
- Tests are deterministic: no network, no live models. Use the fake or
  harness providers.
- Documentation uses hyphens, not em dashes.
- New error codes get entries in `docs/usage/diagnostics.md`; material
  design decisions get an ADR in `docs/adr/`.

## Workflow

1. Small commits, each leaving the tree green (`feat|fix|docs|chore: ...`).
2. PRs are reviewed partly by requirement: CI runs
   `spc verify --format github` against `specs/self-hosting.yaml`, so
   unsatisfied tool requirements show up as annotations on your PR. Keep
   them green or explain in the description.
3. Feature-scale changes are welcome to use spc itself: author a spec under
   `specs/`, run the loop, and let the PR carry the evidence. Do not edit
   `.spc/` runtime records by hand - status comes from evidence, not from
   us.

## Reporting issues

Include: what you ran, the exit code, the diagnostic code (SPC* or named
runtime code), and for runs the `.spc/runs/<id>/summary.md` if one exists.
Never paste secret values.
