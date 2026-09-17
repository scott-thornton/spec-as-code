import { z } from "zod";
import type { LLMProvider, StructuredRequest, StructuredResponse, Usage } from "@spc/llm";
import { LLMError, LLM_INVALID_STRUCTURED_OUTPUT, LLM_TIMEOUT, validateStructured } from "@spc/llm";
import { HarnessStore } from "./store.js";

export const HARNESS_RESPONSE_TIMEOUT = "LLM_HARNESS_RESPONSE_TIMEOUT";

const POLL_INTERVAL_MS = 1_000;

const HARNESS_INSTRUCTIONS = `You are the model backend for an spc run. Read the system and prompt, inspect the repository as needed, and produce a single JSON value satisfying jsonSchema exactly. Save your answer with: spc agent respond <id> --file <answer.json> (the file must contain the JSON value itself, not a wrapper). Then the run continues automatically.`;

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
export class HarnessProvider implements LLMProvider {
  readonly name = "harness";
  readonly model = "harness-agent";

  constructor(
    private readonly store: HarnessStore,
    private readonly timeoutMs = 900_000,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const started = Date.now();
    const invocation = this.store.nextInvocation(request.role, request.key ?? "default");
    const id = this.store.requestId(request.role, request.key ?? "default", invocation);

    let jsonSchema: unknown = null;
    try {
      jsonSchema = z.toJSONSchema(request.schema as z.ZodType<unknown>, { io: "output" });
    } catch {
      jsonSchema = { type: "object", note: `schema ${request.schemaName} could not be rendered` };
    }

    this.store.putRequest({
      id,
      role: request.role,
      key: request.key ?? "default",
      schemaName: request.schemaName,
      jsonSchema,
      system: request.system,
      prompt: `${request.prompt}\n\n--- harness instructions ---\n${HARNESS_INSTRUCTIONS.replace("<id>", id)}`,
      createdAt: new Date().toISOString(),
    });

    while (Date.now() - started < this.timeoutMs) {
      await this.sleep(POLL_INTERVAL_MS);
      if (!this.store.hasAnswer(id)) continue;

      const answer = this.store.getAnswer(id);
      if (!answer) continue;
      const validation = validateStructured(request.schema, answer.value);
      if (validation.ok) {
        this.store.clearPending(id);
        const usage: Usage = { model: this.model, durationMs: Date.now() - started };
        return { value: validation.value, usage };
      }
      // Invalid answer: keep the request pending with feedback so the
      // answering agent can retry within the same timeout window.
      this.store.requeueWithFeedback(
        id,
        validation.issues.slice(0, 8).map((i) => `${i.path || "<root>"}: ${i.message}`).join("; "),
      );
    }
    throw new LLMError(
      HARNESS_RESPONSE_TIMEOUT,
      `harness request ${id} (role ${request.role}) was not answered with a valid value within ${this.timeoutMs}ms; see .spc/harness/pending/${id}.json`,
    );
  }
}

export { LLM_INVALID_STRUCTURED_OUTPUT };
