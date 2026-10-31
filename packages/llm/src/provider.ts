import type { ZodType } from "zod";

/**
 * Provider-neutral structured generation. The rest of the system never
 * depends on a vendor SDK.
 */

export type LLMRole = "planner" | "executor" | "replanner" | "verifier";

export interface StructuredRequest<T> {
  role: LLMRole;
  requestId: string;
  system: string;
  prompt: string;
  schema: ZodType<T>;
  schemaName: string;
  /**
   * Stable routing hint for scripted/deterministic providers (e.g. "T001@2"
   * for the second executor attempt). Real providers ignore it.
   */
  key?: string;
  /**
   * The spc run dispatching this request, when one exists (pre-run
   * planner requests carry none). The harness provider stamps it on the
   * pending request so cancellation can retire the run's queue entries;
   * real providers ignore it.
   */
  runId?: string;
  maxTokens?: number;
  /**
   * Rejection reason from a prior attempt at this role (e.g. plan
   * validation diagnostics). The harness provider surfaces it as the
   * pending request's lastError, so the answering agent sees WHY there
   * is a retry, not just that there is one.
   */
  previousRejection?: string;
}

export interface Usage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** OpenAI wire: completion_tokens_details.reasoning_tokens, when the
   *  endpoint reports it - reasoning-token visibility for budget
   *  diagnosis and any capability measurement. */
  reasoningTokens?: number;
  /** Endpoint-reported cache economics (anthropic wire:
   *  cache_read_input_tokens / cache_creation_input_tokens; openai
   *  wire: prompt_tokens_details.cached_tokens, read side only).
   *  Measurement surface, not policy - the reasoningTokens precedent. */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  durationMs: number;
}

export interface StructuredResponse<T> {
  value: T;
  usage: Usage;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>>;
}
