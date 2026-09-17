#!/bin/zsh
# Standalone spc walkthrough: copy the example repo to a temp directory,
# git-init it, and run the full loop with the real provider.
#
#   GLM_API_KEY=… ./run-demo.sh [model]      # default model: glm-5.3
#
# Requires the monorepo packages to be built (pnpm build at the repo root).
set -u
MODEL="${1:-glm-5.3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MONOREPO="$(cd "$HERE/../.." && pwd)"
SPC="$MONOREPO/packages/cli/dist/main.js"
WORK="$(mktemp -d /tmp/spc-demo-XXXXXX)"

cp -R "$HERE/." "$WORK"/
cd "$WORK"
git init -q -b main
git add -A
git -c user.name=demo -c user.email=demo@local commit -qm "bookmark-service v1.4.0"

echo "## workdir: $WORK"
echo
echo "\$ spc spec validate specs/bookmarks-tags-csv.yaml"
node "$SPC" spec validate specs/bookmarks-tags-csv.yaml
echo
echo "\$ spc plan specs/bookmarks-tags-csv.yaml"
node "$SPC" plan specs/bookmarks-tags-csv.yaml
echo
echo "\$ spc apply"
node "$SPC" apply
echo
echo "\$ spc status"
node "$SPC" status
echo
echo "\$ spc diff"
node "$SPC" diff
echo
RUN_ID=$(ls .spc/runs | grep '^run-' | head -1)
echo "\$ spc run pr $RUN_ID"
node "$SPC" run pr "$RUN_ID"
echo
echo "(worktree with the applied branch: $WORK/.spc/worktrees)"
