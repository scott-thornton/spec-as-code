patch-fresh-build / run run-mw5j2h6y-1ab0c814. Run SUCCEEDED fully
in-run (battery included). Diff is one block in runPatchApply (package-
dir resolution + surgical *.tsbuildinfo deletion + report line) and one
import - proportional self-review: verified the walk stops at the first
package.json ancestor (no root sweep when none found), deletion is
best-effort per file (an unwritable dir cannot fail the apply), only
touched packages are swept, and the report line matches the oracle's
regex. The invalidation runs AFTER staging succeeds - refused applies
change nothing and invalidate nothing. Dogfood note: the apply of these
very ops printed the invalidation line for packages/cli - the fix
guards itself.
