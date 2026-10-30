import { z } from "zod";
import type { LLMProvider, StructuredRequest, StructuredResponse, Usage } from "@spc/llm";
import { LLMError, LLM_INVALID_STRUCTURED_OUTPUT, LLM_TIMEOUT, validateStructured } from "@spc/llm";
import { HarnessStore } from "./store.js";

export const HARNESS_RESPONSE_TIMEOUT = "LLM_HARNESS_RESPONSE_TIMEOUT";

const POLL_INTERVAL_MS = 1_000;

/** Deadline refreshes stop after this many invalid answers, so a loop of
 * garbage submissions cannot keep a request pending forever. */
const MAX_REQUEUE_REFRESHES = 5;

const HARNESS_INSTRUCTIONS = `You are the model backend for an spc run. Read the system and prompt, inspect the repository as needed, and produce a single JSON value satisfying jsonSchema exactly. Save your answer with: spc agent respond <id> --file <answer.json> (the file must contain the JSON value itself, not a wrapper). Then the run continues automatically.`;

/**
 * Pipeline stage headers (specs/pipeline-signposting): every dispatched
 * request states its stage and its local rules - the one surface a
 * queue agent is guaranteed to read. A post-compression agent reads
 * its position on first contact, without remembering anything.
 */
const STAGE_HEADERS: Record<string, string> = {
  planner:
    "stage: plan (3 of 7) - compose the transition plan; cover every requirement; the pipeline map is one command away (follow: spc use-skill pipeline).",
  executor:
    "stage: answer discipline (4 of 7) - draft in a scratch file, then spc agent validate, then spc agent dry-run --gates, then spc agent respond; if the window runs out mid-rehearsal, spc agent save-candidate - never a rushed submit (follow: spc use-skill rehearse).",
  replanner:
    "stage: replan (within the run) - read the request's lastError for why the prior answer or plan was rejected and amend within the declared scopes (follow: spc use-skill pipeline).",
  verifier:
    "stage: verify - judge each criterion on the recorded evidence and cite its id (follow: spc use-skill pipeline).",
};
const GENERIC_STAGE_HEADER =
  "stage: unknown - the pipeline map is one command away (follow: spc use-skill pipeline).";

/**
 * Harness provider: the "model" is an external agent (a coding harness such
 * as ZCode, or a human with an editor) working in the same repository.
 * Each structured request is written to .spc/harness/pending/ with its JSON
 * Schema embedded; the provider polls for the answer, validates it against
 * the same zod schema every other provider uses, requeues invalid answers
 * with feedback, and times out with a typed error. All spc guardrails
 * (plan validation, write-scope enforcement, verification) apply unchanged
 * to harness answers.
 */
/** Built-in window calibration (specs/window-recalibration): windows are
 *  abandonment detection under the post-queue-legibility safety
 *  machinery, sized for reasoning-heavy composition - executor
 *  changesets are the heaviest work, planner and replanner amendments
 *  next, verifier verdicts and unlisted roles take the global. */
export const BUILT_IN_GLOBAL_WINDOW_MS = 1_800_000;
export const BUILT_IN_ROLE_WINDOWS: Partial<Record<string, number>> = {
  executor: 3_600_000,
  planner: 2_400_000,
  replanner: 2_400_000,
};

/** Precedence: an explicit per-role entry beats everything; an
 *  explicitly configured global (any value other than the built-in
 *  global) beats the built-in role weights; built-ins apply only where
 *  the config says nothing. */
export function resolveWindowMs(role: string, explicitGlobalMs: number, explicitRole?: Partial<Record<string, number>>): number {
  const roleExplicit = explicitRole?.[role];
  if (roleExplicit !== undefined) return roleExplicit;
  if (explicitGlobalMs !== BUILT_IN_GLOBAL_WINDOW_MS) return explicitGlobalMs;
  return BUILT_IN_ROLE_WINDOWS[role] ?? BUILT_IN_GLOBAL_WINDOW_MS;
}

export class HarnessProvider implements LLMProvider {
  readonly name = "harness";
  readonly model = "harness-agent";

  constructor(
    private readonly store: HarnessStore,
    private readonly timeoutMs = 900_000,
    /** Injected sleep must yield to the event loop. An immediately-
     *  resolving promise causes the polling loop to spin through
     *  microtasks, starving timers (including test timeouts). */
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = () => Date.now(),
    /** Role-specific windows; roles without an entry use timeoutMs. */
    private readonly roleTimeouts?: Partial<Record<string, number>>,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    // Window anchor: moved forward on each invalid answer (bounded by
    // MAX_REQUEUE_REFRESHES), because feedback rounds burn wall clock the
    // answering agent is spending on real work. The window exists to
    // catch abandonment, not to starve active iteration.
    let windowStart = this.now();
    let invalidAnswers = 0;
    const invocation = this.store.nextInvocation(request.role, request.key ?? "default");
    const id = this.store.requestId(request.role, request.key ?? "default", invocation);

    let jsonSchema: unknown = null;
    try {
      jsonSchema = z.toJSONSchema(request.schema as z.ZodType<unknown>, { io: "output" });
    } catch {
      jsonSchema = { type: "object", note: `schema ${request.schemaName} could not be rendered` };
    }

    const windowMs = resolveWindowMs(request.role ?? "", this.timeoutMs, this.roleTimeouts);
    // The request carries its own deadline, stamped from the SAME knob
    // the poll loop below uses, so every queue surface can derive
    // liveness without sharing provider config.
    this.store.putRequest({
      id,
      role: request.role,
      key: request.key ?? "default",
      schemaName: request.schemaName,
      jsonSchema,
      system: request.system,
      prompt: `--- harness instructions ---\n${STAGE_HEADERS[request.role] ?? GENERIC_STAGE_HEADER}\n${HARNESS_INSTRUCTIONS.replace("<id>", id)}\n\n${request.prompt}`,
      createdAt: new Date(windowStart).toISOString(),
      expiresAt: new Date(windowStart + windowMs).toISOString(),
      ...(request.runId ? { runId: request.runId } : {}),
      // Seed visible feedback for retries caused AFTER the store accepted
      // the prior answer (e.g. plan validation): the answerer reads the
      // queue, not the consuming process's stderr.
      ...(request.previousRejection ? { lastError: request.previousRejection } : {}),
    });

    while (this.now() < windowStart + windowMs) {
      await this.sleep(POLL_INTERVAL_MS);
      if (!this.store.hasAnswer(id)) continue;

      const answer = this.store.getAnswer(id);
      if (!answer) continue;
      const validation = validateStructured(request.schema, answer.value);
      if (validation.ok) {
        this.store.clearPending(id);
        const usage: Usage = { model: this.model, durationMs: this.now() - windowStart };
        return { value: validation.value, usage };
      }
      // Invalid answer: keep the request pending with feedback so the
      // answering agent can retry; refresh the window so the retry is not
      // starved by the rounds already spent (capped: garbage loops must
      // still time out).
      this.store.requeueWithFeedback(
        id,
        validation.issues.slice(0, 8).map((i) => `${i.path || "<root>"}: ${i.message}`).join("; "),
        invalidAnswers + 1 <= MAX_REQUEUE_REFRESHES ? windowMs : undefined,
      );
      invalidAnswers += 1;
      if (invalidAnswers <= MAX_REQUEUE_REFRESHES) {
        windowStart = this.now();
      }
    }
    // Die loudly: expire the orphaned request out of the live queue
    // immediately (a later session must never answer a dead request),
    // then surface the timeout.
    this.store.expirePending(id);
    throw new LLMError(
      HARNESS_RESPONSE_TIMEOUT,
      `harness request ${id} (role ${request.role}) was not answered with a valid value within ${windowMs}ms; see .spc/harness/stale/${id}.json`,
    );
  }
}

export { LLM_INVALID_STRUCTURED_OUTPUT };
