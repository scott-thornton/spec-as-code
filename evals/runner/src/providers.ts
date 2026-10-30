import { AnthropicCompatProvider } from "@spc/llm-anthropic";
import { OpenAICompatProvider } from "@spc/llm-openai";
import type { LLMProvider } from "@spc/llm";
import { RetryingProvider } from "./retry.js";

/** Explicit per-arm provider configuration for real (API) providers
 *  (specs/runner-budget-flags): benchmark arm configuration belongs in
 *  the recorded, reproducible launch command - flags, not inherited
 *  config. The adapters remain the guards; values pass through. */
export interface RealProviderFlags {
  provider: "openai" | "anthropic";
  model?: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  thinkingBudgetTokens?: number;
  reasoningEffort?: string;
  maxTokens?: number;
}

/** The EFFECTIVE options the constructed providers received, after
 *  defaults - arm provenance recorded into the benchmark artifacts.
 *  Optional fields appear only when set; the API key never appears. */
export interface ProviderProvenance {
  provider: "openai" | "anthropic";
  model: string;
  timeoutMs: number;
  baseURL?: string;
  maxTokens?: number;
  thinkingBudgetTokens?: number;
  reasoningEffort?: string;
}

/**
 * Build the control and treatment providers for a real-provider run,
 * wiring the budget/effort/token flags per dialect. Omission semantics
 * preserve historical comparability: an absent --max-tokens keeps the
 * anthropic branch's 16384 and passes none to the openai branch (its
 * own default applies).
 */
export function buildRealProviderPair(flags: RealProviderFlags): {
  control: LLMProvider;
  treatment: LLMProvider;
  provenance: ProviderProvenance;
} {
  const anthropic = flags.provider === "anthropic";
  const model = flags.model ?? (anthropic ? "glm-4.6" : "gpt-4.1");
  const maxTokens = anthropic ? (flags.maxTokens ?? 16_384) : flags.maxTokens;
  const provenance: ProviderProvenance = {
    provider: flags.provider,
    model,
    timeoutMs: flags.timeoutMs,
    ...(flags.baseUrl ? { baseURL: flags.baseUrl } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(anthropic && flags.thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens: flags.thinkingBudgetTokens } : {}),
    ...(flags.reasoningEffort !== undefined ? { reasoningEffort: flags.reasoningEffort } : {}),
  };
  const make = (): LLMProvider =>
    anthropic
      ? new RetryingProvider(
          new AnthropicCompatProvider({
            model,
            apiKey: flags.apiKey,
            ...(flags.baseUrl ? { baseURL: flags.baseUrl } : {}),
            timeoutMs: flags.timeoutMs,
            ...(flags.maxTokens !== undefined ? { maxTokens: flags.maxTokens } : { maxTokens: 16_384 }),
            ...(flags.thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens: flags.thinkingBudgetTokens } : {}),
            ...(flags.reasoningEffort !== undefined ? { reasoningEffort: flags.reasoningEffort as never } : {}),
          }),
        )
      : new RetryingProvider(
          new OpenAICompatProvider({
            model,
            apiKey: flags.apiKey,
            ...(flags.baseUrl ? { baseURL: flags.baseUrl } : {}),
            timeoutMs: flags.timeoutMs,
            ...(flags.maxTokens !== undefined ? { maxTokens: flags.maxTokens } : {}),
            ...(flags.reasoningEffort !== undefined ? { reasoningEffort: flags.reasoningEffort as never } : {}),
          }),
        );
  return { control: make(), treatment: make(), provenance };
}
