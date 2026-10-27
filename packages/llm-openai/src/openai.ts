import type { LLMProvider, StructuredRequest, StructuredResponse, Usage } from "@spc/llm";
import {
  LLMError,
  LLM_CONTEXT_EXHAUSTED,
  LLM_EMPTY_COMPLETION,
  LLM_PROVIDER_FAILURE,
  LLM_RATE_LIMITED,
  LLM_TIMEOUT,
  LLM_TRUNCATED_OUTPUT,
  parseStructured,
  schemaHint,
} from "@spc/llm";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Union of documented effort values across vendors (model support is a
 *  separate compatibility concern - syntactic validity is all we check). */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface OpenAIProviderOptions {
  model: string;
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
  /** Per-provider token limit; resolves with any request-level override
   *  into ONE effective value emitted under exactly one field. */
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** The token-limit dialect: max_tokens (historical default) or
   *  max_completion_tokens (official API - the field that accounts for
   *  reasoning tokens in the bound; required for o-series). */
  tokenLimitField?: "max_tokens" | "max_completion_tokens";
  /** Tri-state: undefined = temperature 0 (HISTORICAL default); false =
   *  omit (the reasoning-endpoint remedy); true = temperature 0. */
  sendTemperature?: boolean;
  /** Anthropic-only manual thinking; refused on this wire. */
  thinkingBudgetTokens?: number;
  fetchImpl?: FetchLike;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; type?: string };
}

function validate(opts: OpenAIProviderOptions): string[] {
  const problems: string[] = [];
  if (opts.thinkingBudgetTokens !== undefined) {
    problems.push("provider.thinkingBudgetTokens is Anthropic-only (the manual thinking budget has no OpenAI wire form)");
  }
  if (opts.tokenLimitField !== undefined && opts.tokenLimitField !== "max_tokens" && opts.tokenLimitField !== "max_completion_tokens") {
    problems.push(`provider.tokenLimitField must be max_tokens or max_completion_tokens (got "${opts.tokenLimitField}")`);
  }
  if (opts.reasoningEffort !== undefined && opts.sendTemperature === true) {
    problems.push("provider.sendTemperature true conflicts with a reasoning control");
  }
  return problems;
}

/**
 * Adapter for any OpenAI-compatible chat completions endpoint. Uses only
 * the platform fetch - no vendor SDK dependency. Deterministic CI never
 * calls this provider. Protocol expressibility is not model
 * compatibility: historical defaults are preserved byte-identically
 * (temperature 0 when sendTemperature is unset), and failures
 * self-diagnose without fallback or retry.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly maxTokens?: number;
  private readonly reasoningEffort?: ReasoningEffort;
  private readonly tokenLimitField: "max_tokens" | "max_completion_tokens";
  private readonly sendTemperature?: boolean;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpenAIProviderOptions) {
    const problems = validate(opts);
    if (problems.length > 0) {
      throw new Error(`PROVIDER_CONFIG: ${problems.join("; ")}`);
    }
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseURL = (opts.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxTokens = opts.maxTokens;
    this.reasoningEffort = opts.reasoningEffort;
    this.tokenLimitField = opts.tokenLimitField ?? "max_tokens";
    this.sendTemperature = opts.sendTemperature;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const started = Date.now();
    const effectiveMax = request.maxTokens ?? this.maxTokens;
    const reasoningDesc = this.reasoningEffort !== undefined ? `reasoningEffort ${this.reasoningEffort}` : "no reasoning control configured";
    const remediation = `raise provider.maxTokens, lower provider.reasoningEffort, or switch provider.tokenLimitField to max_completion_tokens so reasoning tokens count inside the bound (${reasoningDesc})`;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: `${request.prompt}\n\n${schemaHint(request.schema as never, request.schemaName)}` },
      ],
      response_format: { type: "json_object" },
    };
    // Tri-state temperature: the HISTORICAL default (unset) sends 0 and
    // is locked by fixture; false omits for reasoning-style endpoints.
    if (this.sendTemperature !== false) body["temperature"] = 0;
    if (this.reasoningEffort !== undefined) body["reasoning_effort"] = this.reasoningEffort;
    // ONE token-limit field, under the configured dialect, only when a
    // limit exists - the request-level override and the provider-level
    // limit resolve into this single emission.
    if (effectiveMax !== undefined) body[this.tokenLimitField] = effectiveMax;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const timeoutRace = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new LLMError(LLM_TIMEOUT, `provider request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    });
    let res: Response;
    try {
      res = await Promise.race([
        this.fetchImpl(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        timeoutRace,
      ]);
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
    const choice = json?.choices?.[0];
    const content = choice?.message?.content;
    const finish = choice?.finish_reason;
    if (typeof content !== "string" || content.trim() === "") {
      throw new LLMError(
        LLM_EMPTY_COMPLETION,
        `provider response contained no message content (finish_reason: ${finish ?? "unknown"}; completion_tokens: ${json?.usage?.completion_tokens ?? "?"}${effectiveMax !== undefined ? ` of limit ${effectiveMax}` : ""}; configured: ${reasoningDesc}); ${remediation}`,
      );
    }
    if (finish === "length") {
      throw new LLMError(
        LLM_TRUNCATED_OUTPUT,
        `output terminated at the token limit (finish_reason: length; completion_tokens: ${json?.usage?.completion_tokens ?? "?"}${effectiveMax !== undefined ? ` of ${effectiveMax}` : ""}; configured: ${reasoningDesc}); ${remediation}`,
      );
    }
    const value = parseStructured(request.schema, content);
    const usage: Usage & { reasoningTokens?: number } = {
      model: this.model,
      durationMs: Date.now() - started,
      inputTokens: json?.usage?.prompt_tokens,
      outputTokens: json?.usage?.completion_tokens,
      ...(json?.usage?.completion_tokens_details?.reasoning_tokens !== undefined
        ? { reasoningTokens: json.usage.completion_tokens_details.reasoning_tokens }
        : {}),
    };
    return { value, usage };
  }
}
