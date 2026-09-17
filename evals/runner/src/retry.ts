import type { LLMProvider, StructuredRequest, StructuredResponse } from "@spc/llm";
import { isRetryableLLMError } from "@spc/llm";

const DELAYS_MS = [5_000, 15_000];

/**
 * Wraps a provider with bounded retries for transient failures (timeouts,
 * rate limits, 5xx). Real benchmark runs are long; one 429 must not sink a
 * task.
 */
export class RetryingProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;

  constructor(
    private readonly inner: LLMProvider,
    private readonly delays: readonly number[] = DELAYS_MS,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.name = inner.name;
    this.model = inner.model;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.delays.length; attempt++) {
      try {
        return await this.inner.generateStructured(request);
      } catch (e) {
        lastError = e;
        if (attempt >= this.delays.length || !isRetryableLLMError(e)) throw e;
        await this.sleep(this.delays[attempt]!);
      }
    }
    throw lastError;
  }
}
