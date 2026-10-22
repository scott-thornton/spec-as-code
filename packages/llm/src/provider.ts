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
