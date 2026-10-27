import { describe, expect, it } from "vitest";
import { AnthropicCompatProvider } from "./anthropic.js";
import { LLM_EMPTY_COMPLETION, LLM_TIMEOUT, LLM_TRUNCATED_OUTPUT } from "@spc/llm";

// Oracle for specs/provider-budget.yaml (PB-001/PB-002, Anthropic wire):
// faithful serialization of both reasoning modes, historical defaults
// locked byte-identically, named refusal classification at construction
// and send time, self-diagnosing exhaustion taxonomy, abort-proof
// timeout. No live network - the fixture fetch records exact bodies.

type Recorded = { url: string; body: Record<string, unknown> };

function recorder(responder: (rec: Recorded) => Response): { provider: AnthropicCompatProvider; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (url: string, init: RequestInit): Promise<Response> =>
    new Promise((resolve) => {
      const rec = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
      calls.push(rec);
      resolve(responder(rec));
    });
  return {
    provider: new AnthropicCompatProvider({ model: "m", apiKey: "k", fetchImpl: fetchImpl as never }),
    calls,
  };
}

import { z } from "zod";
const SCHEMA = z.strictObject({ ok: z.boolean() });
const REQ = { role: "planner" as const, requestId: "r", system: "s", prompt: "p", schema: SCHEMA, schemaName: "S" };
const RESP_HEADERS = { status: 200 } as ResponseInit;

function anthropicResponse(content: { type: string; text?: string; thinking?: string }[], extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ content, usage: { input_tokens: 10, output_tokens: 8192 }, ...extra }), RESP_HEADERS);
}

const okText = () => anthropicResponse([{ type: "text", text: '{"ok":true}' }]);
const thinkingOnly = () => anthropicResponse([{ type: "thinking", thinking: "…" }], { stop_reason: "max_tokens" });
const truncated = () => anthropicResponse([{ type: "thinking", thinking: "…" }, { type: "text", text: '{"ok":' }], { stop_reason: "max_tokens" });

describe("Anthropic wire expressibility (PB-001)", () => {
  it("reasoningEffort serializes as output_config.effort + adaptive thinking", async () => {
    const { provider, calls } = recorder(okText);
    const p = new AnthropicCompatProvider({ model: "m", apiKey: "k", fetchImpl: (async (_u, i) => { calls.push({ url: _u, body: JSON.parse(String(i.body)) }); return okText(); }) as never, reasoningEffort: "high" });
    await p.generateStructured(REQ as never);
    expect(calls[0]!.body["output_config"]).toEqual({ effort: "high" });
    expect(calls[0]!.body["thinking"]).toEqual({ type: "adaptive" });
    expect(calls[0]!.body["temperature"]).toBeUndefined();
  });

  it("thinkingBudgetTokens serializes the manual block under max_tokens", async () => {
    const { provider: _unused, calls } = { provider: null, calls: [] as Recorded[] };
    const p = new AnthropicCompatProvider({ model: "m", apiKey: "k", fetchImpl: (async (_u, i) => { calls.push({ url: _u, body: JSON.parse(String(i.body)) }); return okText(); }) as never, thinkingBudgetTokens: 4096, maxTokens: 16384 });
    await p.generateStructured(REQ as never);
    expect(calls[0]!.body["thinking"]).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(calls[0]!.body["max_tokens"]).toBe(16384);
  });

  it("NO config: the body is byte-compatible with history - no thinking, no output_config, no temperature", async () => {
    const { provider, calls } = recorder(okText);
    await provider.generateStructured(REQ as never);
    const body = calls[0]!.body;
    expect(body["thinking"]).toBeUndefined();
    expect(body["output_config"]).toBeUndefined();
    expect(body["temperature"]).toBeUndefined();
    expect(body["max_tokens"]).toBe(8192);
  });

  it("sendTemperature true adds temperature 0; explicit false omits", async () => {
    const mk = (sendTemperature?: boolean) => {
      const calls: Recorded[] = [];
      const p = new AnthropicCompatProvider({ model: "m", apiKey: "k", fetchImpl: (async (_u, i) => { calls.push({ url: _u, body: JSON.parse(String(i.body)) }); return okText(); }) as never, ...(sendTemperature !== undefined ? { sendTemperature } : {}) });
      return { p, calls };
    };
    const on = mk(true);
    await on.p.generateStructured(REQ as never);
    expect(on.calls[0]!.body["temperature"]).toBe(0);
    const off = mk(false);
    await off.p.generateStructured(REQ as never);
    expect(off.calls[0]!.body["temperature"]).toBeUndefined();
  });

  const refuse = (name: string, opts: Record<string, unknown>, match: RegExp) =>
    it(`construction refuses: ${name}`, () => {
      expect(() => new AnthropicCompatProvider({ model: "m", apiKey: "k", fetchImpl: (async () => okText()) as never, ...opts } as never)).toThrow(match);
    });

  refuse("budget below the 1024 floor", { thinkingBudgetTokens: 512, maxTokens: 8192 }, /1024/);
  refuse("budget not below effective max", { thinkingBudgetTokens: 8192, maxTokens: 8192 }, /budget/);
  refuse("effort and budget together (policy; Opus 4.5 exception named)", { reasoningEffort: "high", thinkingBudgetTokens: 4096, maxTokens: 16384 }, /Opus 4.5|one of/);
  refuse("effort with sendTemperature true", { reasoningEffort: "high", sendTemperature: true }, /sendTemperature/);
  refuse("budget with sendTemperature true", { thinkingBudgetTokens: 4096, maxTokens: 16384, sendTemperature: true }, /sendTemperature/);
  refuse("effort value not expressible on the Anthropic wire", { reasoningEffort: "none" }, /none|Anthropic/);
  refuse("openai-only tokenLimitField", { tokenLimitField: "max_completion_tokens" }, /tokenLimitField|OpenAI/);

  it("send-time: a request maxTokens override at or below the budget refuses BEFORE the fetch", async () => {
    const calls: Recorded[] = [];
    const p = new AnthropicCompatProvider({ model: "m", apiKey: "k", fetchImpl: (async (_u, i) => { calls.push({ url: _u, body: JSON.parse(String(i.body)) }); return okText(); }) as never, thinkingBudgetTokens: 4096, maxTokens: 16384 });
    await expect(p.generateStructured({ ...REQ, maxTokens: 4000 } as never)).rejects.toThrow(/max_tokens.*budget|budget.*max_tokens|PROVIDER_CONFIG/i);
    expect(calls.length).toBe(0);
  });
});

describe("Anthropic failure taxonomy (PB-002)", () => {
  it("thinking-only at the limit: LLM_EMPTY_COMPLETION with stop_reason, tokens, remediation", async () => {
    const p = new AnthropicCompatProvider({ model: "m", apiKey: "k", fetchImpl: (async () => thinkingOnly()) as never, thinkingBudgetTokens: 4096, maxTokens: 8192 });
    await expect(p.generateStructured(REQ as never)).rejects.toMatchObject({ code: LLM_EMPTY_COMPLETION });
    try {
      await p.generateStructured(REQ as never);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("max_tokens");
      expect(msg).toContain("8192");
      expect(msg).toMatch(/thinkingBudgetTokens|maxTokens/);
    }
  });

  it("partial text at the limit: LLM_TRUNCATED_OUTPUT even though the fragment is present", async () => {
    const p = new AnthropicCompatProvider({ model: "m", apiKey: "k", fetchImpl: (async () => truncated()) as never });
    await expect(p.generateStructured(REQ as never)).rejects.toMatchObject({ code: LLM_TRUNCATED_OUTPUT });
  });

  it("timeout fires even when the fetch ignores the AbortSignal", async () => {
    const p = new AnthropicCompatProvider({ model: "m", apiKey: "k", timeoutMs: 30, fetchImpl: (async () => new Promise<Response>(() => {})) as never });
    await expect(p.generateStructured(REQ as never)).rejects.toMatchObject({ code: LLM_TIMEOUT });
  });

  it("normal thinking+text: thinking skipped, value parsed, tokens recorded", async () => {
    const p = new AnthropicCompatProvider({ model: "m", apiKey: "k", fetchImpl: (async () => anthropicResponse([{ type: "thinking", thinking: "hmm" }, { type: "text", text: '{"ok":true}' }])) as never });
    const r = await p.generateStructured(REQ as never);
    expect(r.value).toEqual({ ok: true });
    expect(r.usage.inputTokens).toBe(10);
    expect(r.usage.outputTokens).toBe(8192);
  });
});
