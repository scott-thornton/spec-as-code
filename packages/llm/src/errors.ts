import { SpcError } from "@spc/core";

export const LLM_TIMEOUT = "LLM_TIMEOUT";
export const LLM_PROVIDER_FAILURE = "LLM_PROVIDER_FAILURE";
export const LLM_INVALID_STRUCTURED_OUTPUT = "LLM_INVALID_STRUCTURED_OUTPUT";
export const LLM_RATE_LIMITED = "LLM_RATE_LIMITED";
export const LLM_CONTEXT_EXHAUSTED = "LLM_CONTEXT_EXHAUSTED";

export class LLMError extends SpcError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, details);
    this.name = "LLMError";
  }
}

/** Retryable provider failures (network, 5xx, rate limits). */
export function isRetryableLLMError(e: unknown): boolean {
  return e instanceof LLMError && (e.code === LLM_TIMEOUT || e.code === LLM_RATE_LIMITED || e.code === LLM_PROVIDER_FAILURE);
}
