import type { LLMProvider, StructuredRequest, StructuredResponse, Usage } from "@spc/llm";
import { LLMError, LLM_CONTEXT_EXHAUSTED, LLM_PROVIDER_FAILURE, LLM_RATE_LIMITED, LLM_TIMEOUT } from "@spc/llm";
import { parseStructured, schemaHint } from "@spc/llm";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AnthropicProviderOptions {
  model: string;
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Thinking models reject non-default sampling params; temperature is omitted by default. */
  sendTemperature?: boolean;
  fetchImpl?: FetchLike;
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

/**
 * Adapter for Anthropic-compatible Messages APIs (including GLM's coding
 * endpoint at https://api.z.ai/api/anthropic). Thinking blocks are skipped;
 * only text blocks are parsed as structured output.
 */
export class AnthropicCompatProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly sendTemperature: boolean;
  private readonly fetchImpl: FetchLike;

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseURL = (opts.baseURL ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.maxTokens = opts.maxTokens ?? 8192;
    this.sendTemperature = opts.sendTemperature ?? false;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      system: request.system,
      messages: [
        {
          role: "user",
          content: `${request.prompt}\n\n${schemaHint(request.schema as never, request.schemaName)}`,
        },
      ],
    };
    if (this.sendTemperature) body.temperature = 0;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
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
    if (res.status === 400 && /context|token|too long/i.test(await res.clone().text().catch(() => ""))) {
      throw new LLMError(LLM_CONTEXT_EXHAUSTED, "provider rejected the request as too large");
    }
    if (!res.ok) {
      throw new LLMError(LLM_PROVIDER_FAILURE, `provider returned HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }

    const json = (await res.json().catch(() => null)) as MessagesResponse | null;
    const text = (json?.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    if (text.trim() === "") {
      throw new LLMError(LLM_PROVIDER_FAILURE, "provider response contained no text blocks");
    }
    const value = parseStructured(request.schema, text);
    const usage: Usage = {
      model: this.model,
      durationMs: Date.now() - started,
      inputTokens: json?.usage?.input_tokens,
      outputTokens: json?.usage?.output_tokens,
    };
    return { value, usage };
  }
}
