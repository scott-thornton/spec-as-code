---
name: rehearse
description: Rehearse executor answers before submitting them - draft in a scratch space, build ops with spc patch build, validate, dry-run against the request base, then respond. Use before answering any harness request whose answer carries change ops, and whenever the response window feels short.
---

# rehearse: the irreversible thing goes last

Every answer you submit through the queue stages onto a run. A staging
refusal costs a task attempt; a rehearsal costs minutes. The asymmetry
is the whole skill.

## The five steps

1. **Draft in a scratch file - never the live tree.** Compose the
   answer JSON in /tmp or a scratch directory. The working tree belongs
   to the run.
2. **Build ops with spc patch build - never hand-write digests.**
   Anchors and base digests come from the actual bytes: `spc patch
   build <path> --anchor-file <a> --replacement-file <r>`. For multiple
   ops on one file, chain them with `--after <prior-ops.json>` so each
   op's digest binds the content after the previous op applies.
3. **Cheap check first:** `spc agent validate <id> --file <draft>` -
   schema issues surface locally instead of as a submit-requeue round
   trip.
4. **The real rehearsal:** `spc agent dry-run <id> --file <draft>
   --gates` - stages your changes in a throwaway worktree at the
   request's base revision, runs the task's criteria and the repo
   gates, and touches nothing. Iterate in the scratch until clean. The
   rehearsal records a digest of your draft - submitting a different
   answer than you rehearsed reads as unrehearsed.
5. **Submit, or bank it:** `spc agent respond <id> --file <draft>`.
   Running out of window mid-rehearsal? `spc agent save-candidate
   --file <draft> --request <id>` keeps the composed work claimable by
   a live successor. Never rush the submit to beat the clock - a
   rushed chain is the top staging refusal.

## When the guard fires

`respond` refuses (exit 1, PREFLIGHT_ADVISABLE) when your answer
chains two or more ops on one path and no rehearsal matches it. The
refusal is not a block: rehearse, or push through with
`--no-preflight` when you truly must - the advice still prints.

> Rehearse in the scratch, commit through the queue - the irreversible
> thing goes last.
