#!/usr/bin/env bash
# Rename the npm scope across the monorepo: @spc/* -> @<new>/*
# Usage: scripts/rename-scope.sh <new-scope-without-@>
# Identical mechanical sweep whichever word wins; verify with the full suite after.
set -euo pipefail
NEW="${1:?usage: scripts/rename-scope.sh <new-scope-without-@> (e.g. tenonworks)}"
[[ "$NEW" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "scope must be lowercase kebab: $NEW"; exit 1; }

echo "renaming @spc/* -> @${NEW}/*"
# 1. Package names in manifests (root is private spec-as-code, untouched).
find packages -name package.json -not -path "*/node_modules/*" -exec sed -i '' "s/\"@spc\\//\"@${NEW}\\//g" {} +
# 2. Imports across source (TS ESM specifiers).
grep -rl '@spc/' packages --include='*.ts' --include='*.mjs' --include='*.json' --include='*.yaml' | grep -v node_modules | xargs sed -i '' "s/@spc\\//@${NEW}\\//g"
# 3. tsconfig path mappings, if any.
find packages -name 'tsconfig*.json' -not -path "*/node_modules/*" -exec sed -i '' "s/@spc\\//@${NEW}\\//g" {} +
# 4. Self-hosting spec + evals --filter references and docs mentioning packages.
sed -i '' "s/--filter @spc\\//--filter @${NEW}\\//g" specs/self-hosting.yaml evals/tools/*.sh 2>/dev/null || true
grep -rl '@spc/' docs README.md CONTRIBUTING.md .github 2>/dev/null | xargs sed -i '' "s/@spc\\//@${NEW}\\//g" || true

LEFT=$(grep -r '@spc/' packages specs evals docs README.md 2>/dev/null | grep -v node_modules | wc -l | tr -d ' ')
echo "remaining @spc/ references: $LEFT (expected 0)"
echo "now run: pnpm install --no-frozen-lockfile && pnpm build && pnpm test"
