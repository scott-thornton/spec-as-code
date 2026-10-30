---
name: pipeline
description: The spc pipeline - the seven stages from authored spec to pushed result, each with its exit condition and the command that proves it. Use to orient any session - where am I, what does this stage require, what proves it done.
---

# pipeline: seven stages, each proven before the next

1. **Author** - write the spec (specs/*.yaml) with requirements and
   acceptance criteria. Exit: `spc spec validate <file>` passes.
2. **Red oracle** - encode failure as tests; confirm they fail for the
   right reason; commit spec and oracle together. Exit: discriminating
   criteria recorded red, committed protected.
3. **Plan** - `spc plan <spec>`; answer the planner request through the
   queue. Exit: a validated plan persisted under .spc/plans/.
4. **Answer discipline** - for every executor request: scratch-draft,
   build ops with spc patch build, `spc agent validate`, `spc agent
   dry-run --gates`, then respond - or save-candidate under window
   pressure (follow: spc use-skill rehearse). Exit: a rehearsed answer
   submitted.
5. **Run** - `spc apply <plan>`: staged changes, write-scope
   enforcement, atomic refusals. A staging rejection of an
   answer-defect class (PATCH_*) re-dispatches within the same task
   attempt, bounded - read the request's lastError and correct (see
   staging-requeue). Exit: a terminal run state with recorded evidence.
6. **Verify** - `spc verify <spec>` for the red-to-green flip, then
   `spc verify --all` plus the build/test/typecheck gates. Exit: every
   criterion satisfied and the full battery green - then ONE push.
7. **Adversarial** - attack the result between verify and push (follow:
   spc use-skill adversarial-loop); route what survives as observations
   or followups. Exit: the attack pass recorded, findings routed.

Related skills answer their stages in depth: author-spec (1), spc
(3-6 mechanics), answer-queue and rehearse (4), adverse-review and
adversarial-loop (7).

> A stage without its exit evidence is not done - the next stage's
> entry asks for it.
