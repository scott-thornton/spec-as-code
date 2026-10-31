import type { LLMProvider, StructuredRequest, StructuredResponse, Usage } from "@spc/llm";
import {
  LLMError,
  LLM_CONTEXT_EXHAUSTED,
  LLM_EMPTY_COMPLETION,
  LLM_PROVIDER_FAILURE,
  LLM_RATE_LIMITED,
  LLM_TIMEOUT,
  LLM_TRUNCATED_OUTPUT,
} from "@spc/llm";
import { parseStructured, schemaHint } from "@spc/llm";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Union of documented effort values across vendors; the Anthropic wire
 *  refuses none/minimal at construction (provider-aware validation). */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicProviderOptions {
  model: string;
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Adaptive effort (modern mode): output_config {effort} + thinking adaptive. */
  reasoningEffort?: ReasoningEffort;
  /** Manual thinking budget (legacy mode; deprecated Claude 4.6+, rejected
   *  4.7+; retained for classic compat endpoints). Sets a TARGET - the
   *  maxTokens ceiling still bounds total output including thinking. */
  thinkingBudgetTokens?: number;
  /** OpenAI-only dialect selector; refused on this wire. */
  tokenLimitField?: "max_tokens" | "max_completion_tokens";
  /** Tri-state: undefined = omit (historical); false = omit explicitly; true = send temperature 0. */
  sendTemperature?: boolean;
  /** Opt-in prompt caching for the anthropic wire (specs/cache-markers):
   *  when true, system is sent as a markered block and the schema hint
   *  becomes its own leading markered block ahead of the prompt -
   *  stable-before-variable, structurally. Off leaves the wire
   *  byte-identical to today. The operator opts in per endpoint; the
   *  shipped cache metering verifies engagement (zero
   *  cache_read_input_tokens on a markered run means the endpoint
   *  ignored the markers). */
  cacheControl?: boolean;
  fetchImpl?: FetchLike;
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  stop_reason?: string;
  error?: { message?: string; type?: string };
}

const EFFORT_NOT_ON_WIRE: ReadonlySet<ReasoningEffort> = new Set(["none", "minimal"]);

function validate(opts: AnthropicProviderOptions): string[] {
  const problems: string[] = [];
  if (opts.thinkingBudgetTokens !== undefined) {
    if (opts.thinkingBudgetTokens < 1024) {
      problems.push(`provider.thinkingBudgetTokens must be >= 1024 (got ${opts.thinkingBudgetTokens})`);
    }
    const effectiveMax = opts.maxTokens ?? 8192;
    if (opts.thinkingBudgetTokens >= effectiveMax) {
      problems.push(`provider.thinkingBudgetTokens (${opts.thinkingBudgetTokens}) must be below the effective max_tokens (${effectiveMax}) - thinking draws from the same output budget`);
    }
  }
  if (opts.reasoningEffort !== undefined && opts.thinkingBudgetTokens !== undefined) {
    problems.push(
      "provider.reasoningEffort and provider.thinkingBudgetTokens are mutually exclusive (application policy: pick one reasoning control; the Opus 4.5 exception where both coexist is model-specific - set budget_tokens directly for that case is still refused here by policy)",
    );
  }
  if ((opts.reasoningEffort !== undefined || opts.thinkingBudgetTokens !== undefined) && opts.sendTemperature === true) {
    problems.push("provider.sendTemperature true conflicts with a reasoning control (thinking models reject non-default sampling)");
  }
  if (opts.reasoningEffort !== undefined && EFFORT_NOT_ON_WIRE.has(opts.reasoningEffort)) {
    problems.push(`provider.reasoningEffort "${opts.reasoningEffort}" is not expressible on the Anthropic wire (supported: low, medium, high, xhigh, max)`);
  }
  if (opts.tokenLimitField !== undefined) {
    problems.push(`provider.tokenLimitField is OpenAI-only (got "${opts.tokenLimitField}"); the Anthropic wire has one limit field`);
  }
  return problems;
}

/**
 * Adapter for Anthropic-compatible Messages APIs (including GLM's coding
 * endpoint at https://api.z.ai/api/anthropic). Thinking blocks are skipped;
 * only text blocks are parsed as structured output. Protocol
 * expressibility is not model compatibility: the adapter serializes the
 * documented wire formats and makes failures self-diagnosing (the field
 * observation: 8192 output tokens, thinking-only, no text, no remedy).
 */
export class AnthropicCompatProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly reasoningEffort?: ReasoningEffort;
  private readonly thinkingBudgetTokens?: number;
  private readonly sendTemperature?: boolean;
  private readonly cacheControl?: boolean;
  private readonly fetchImpl: FetchLike;

  constructor(opts: AnthropicProviderOptions) {
    const problems = validate(opts);
    if (problems.length > 0) {
      throw new Error(`PROVIDER_CONFIG: ${problems.join("; ")}`);
    }
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseURL = (opts.baseURL ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.maxTokens = opts.maxTokens ?? 8192;
    this.reasoningEffort = opts.reasoningEffort;
    this.thinkingBudgetTokens = opts.thinkingBudgetTokens;
    this.sendTemperature = opts.sendTemperature;
    this.cacheControl = opts.cacheControl;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const started = Date.now();
    const effectiveMax = request.maxTokens ?? this.maxTokens;
    if (this.thinkingBudgetTokens !== undefined && effectiveMax <= this.thinkingBudgetTokens) {
      throw new Error(
        `PROVIDER_CONFIG: request max_tokens override (${effectiveMax}) is not above the configured thinking budget (${this.thinkingBudgetTokens}) - refusing before the fetch`,
      );
    }
    const reasoningDesc = this.reasoningEffort !== undefined
      ? `reasoningEffort ${this.reasoningEffort}`
      : this.thinkingBudgetTokens !== undefined
        ? `thinkingBudgetTokens ${this.thinkingBudgetTokens}`
        : "no reasoning control configured";
    const remediation = `raise provider.maxTokens, lower provider.thinkingBudgetTokens, or lower provider.reasoningEffort (${reasoningDesc})`;

    const ephemeral = { type: "ephemeral" } as const;
    const body: Record<string, unknown> = this.cacheControl
      ? {
          model: this.model,
          max_tokens: effectiveMax,
          // Markered blocks: system carries the role-constant prefix,
          // and the schema hint becomes its own leading cached block so
          // the stable prefix ends at a block boundary (the off-shape
          // buries the schema hint at the tail of one string - the
          // worst order for prefix caching).
          system: [{ type: "text", text: request.system, cache_control: ephemeral }],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: schemaHint(request.schema as never, request.schemaName), cache_control: ephemeral },
                { type: "text", text: request.prompt },
              ],
            },
          ],
        }
      : {
          model: this.model,
          max_tokens: effectiveMax,
          system: request.system,
          messages: [
            {
              role: "user",
              content: `${request.prompt}\n\n${schemaHint(request.schema as never, request.schemaName)}`,
            },
          ],
        };
    if (this.reasoningEffort !== undefined) {
      body["output_config"] = { effort: this.reasoningEffort };
      body["thinking"] = { type: "adaptive" };
    } else if (this.thinkingBudgetTokens !== undefined) {
      body["thinking"] = { type: "enabled", budget_tokens: this.thinkingBudgetTokens };
    }
    if (this.sendTemperature === true) body["temperature"] = 0;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Race-hardened: even a fetch implementation that ignores the
    // AbortSignal still produces LLM_TIMEOUT when the window closes.
    const timeoutRace = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new LLMError(LLM_TIMEOUT, `provider request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    });
    let res: Response;
    try {
      res = await Promise.race([
        this.fetchImpl(`${this.baseURL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
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
    if (res.status === 400 && /context|token|too long/i.test(await res.clone().text().catch(() => ""))) {
      throw new LLMError(LLM_CONTEXT_EXHAUSTED, "provider rejected the request as too large");
    }
    if (!res.ok) {
      // A reasoning parameter the MODEL does not support is its own
      // failure class: keep the provider's body so it is diagnosable.
      throw new LLMError(LLM_PROVIDER_FAILURE, `provider returned HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }

    const json = (await res.json().catch(() => null)) as MessagesResponse | null;
    const text = (json?.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    if (text.trim() === "") {
      throw new LLMError(
        LLM_EMPTY_COMPLETION,
        `provider response contained no text blocks (stop_reason: ${json?.stop_reason ?? "unknown"}; output_tokens: ${json?.usage?.output_tokens ?? "?"} of max_tokens ${effectiveMax}; configured: ${reasoningDesc}); ${remediation}`,
      );
    }
    if (json?.stop_reason === "max_tokens") {
      throw new LLMError(
        LLM_TRUNCATED_OUTPUT,
        `output terminated at the token limit (stop_reason: max_tokens; output_tokens: ${json?.usage?.output_tokens ?? "?"} of ${effectiveMax}; configured: ${reasoningDesc}); ${remediation}`,
      );
    }
    const value = parseStructured(request.schema, text);
    const usage: Usage = {
      model: this.model,
      durationMs: Date.now() - started,
      inputTokens: json?.usage?.input_tokens,
      outputTokens: json?.usage?.output_tokens,
      ...(json?.usage?.cache_read_input_tokens !== undefined ? { cacheReadTokens: json.usage.cache_read_input_tokens } : {}),
      ...(json?.usage?.cache_creation_input_tokens !== undefined ? { cacheCreationTokens: json.usage.cache_creation_input_tokens } : {}),
    };
    return { value, usage };
  }
}
