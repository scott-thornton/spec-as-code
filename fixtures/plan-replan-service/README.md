# plan-replan-service

End-to-end replanning fixture. The (scripted) planner assumes the session
module lives at `src/auth/session.mjs`; the repository actually has it at
`packages/security/session.mjs`. During execution the executor records an
architecture observation that invalidates T001, the task moves to
`needs_replan`, the replanner replaces it with T003 targeting the real
location, and the run resumes to `succeeded` - with the original plan
version preserved in the run directory.

See the parent README for the commands to run.
