import type { LLMProvider, StructuredRequest, StructuredResponse, Usage } from "@spc/llm";
import { parseStructured } from "@spc/llm";
import { LLMError, LLM_CONTEXT_EXHAUSTED, LLM_PROVIDER_FAILURE, LLM_RATE_LIMITED, LLM_TIMEOUT } from "@spc/llm";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAIProviderOptions {
  model: string;
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

/**
 * Adapter for any OpenAI-compatible chat completions endpoint. Uses only
 * the platform fetch — no vendor SDK dependency. Deterministic CI never
 * calls this provider.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpenAIProviderOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseURL = (opts.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const started = Date.now();
    const body = {
      model: this.model,
      temperature: 0,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      response_format: { type: "json_object" },
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new LLMError(LLM_TIMEOUT, `provider request timed out after ${this.timeoutMs}ms`);
      }
      throw new LLMError(LLM_PROVIDER_FAILURE, `provider request failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new LLMError(LLM_PROVIDER_FAILURE, `provider rejected credentials (HTTP ${res.status})`);
    }
    if (res.status === 429) {
      throw new LLMError(LLM_RATE_LIMITED, "provider rate limited the request");
    }
    if (res.status === 400 && /context|token/i.test(await res.clone().text().catch(() => ""))) {
      throw new LLMError(LLM_CONTEXT_EXHAUSTED, "provider rejected the request as too large");
    }
    if (!res.ok) {
      throw new LLMError(LLM_PROVIDER_FAILURE, `provider returned HTTP ${res.status}`);
    }

    const json = (await res.json().catch(() => null)) as ChatCompletionResponse | null;
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new LLMError(LLM_PROVIDER_FAILURE, "provider response contained no message content");
    }
    const value = parseStructured(request.schema, content);
    const usage: Usage = {
      model: this.model,
      durationMs: Date.now() - started,
      inputTokens: json?.usage?.prompt_tokens,
      outputTokens: json?.usage?.completion_tokens,
    };
    return { value, usage };
  }
}
