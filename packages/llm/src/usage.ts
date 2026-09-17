import { digestOf } from "@spc/core";
import type { LLMRole, Usage } from "./provider.js";

/**
 * Every model invocation is accounted: role, digests, tokens, latency.
 * Secrets are never recorded.
 */
export interface UsageRecord {
  role: LLMRole;
  requestId: string;
  taskId?: string;
  model: string;
  inputDigest: string;
  outputDigest: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  status: "success" | "error";
  errorCode?: string;
  timestamp: string;
}

export function makeUsageRecord(
  role: LLMRole,
  requestId: string,
  input: { system: string; prompt: string },
  output: string,
  usage: Usage,
  options: { taskId?: string; status?: "success" | "error"; errorCode?: string } = {},
): UsageRecord {
  return {
    role,
    requestId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    model: usage.model,
    inputDigest: digestOf({ system: input.system, prompt: input.prompt }),
    outputDigest: digestOf(output),
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    durationMs: usage.durationMs,
    status: options.status ?? "success",
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    timestamp: new Date().toISOString(),
  };
}

export class UsageTracker {
  private readonly records: UsageRecord[] = [];

  record(r: UsageRecord): void {
    this.records.push(r);
  }

  all(): readonly UsageRecord[] {
    return this.records;
  }

  get calls(): number {
    return this.records.length;
  }

  toJSON(): UsageRecord[] {
    return [...this.records];
  }
}
