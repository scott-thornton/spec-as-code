# simple-node-service

End-to-end fixture: a deliberately failing requirement. `tests/greeting.test.mjs`
imports `../src/greeting.mjs`, which does not exist, so `GREETING-001` starts
unsatisfied. The scripted fake provider plans and executes the fix; the run
must finish `succeeded` with deterministic command evidence.

Run the vertical slice (requires a built spc CLI in this monorepo):

```bash
tmp=$(mktemp -d)
cp -r fixtures/simple-node-service/* "$tmp"/
cd "$tmp"
git init -b main && git add -A && git commit -m init
node <monorepo>/packages/cli/dist/main.js spec validate specs/greeting.yaml
node <monorepo>/packages/cli/dist/main.js plan specs/greeting.yaml
node <monorepo>/packages/cli/dist/main.js apply
node <monorepo>/packages/cli/dist/main.js status
```
