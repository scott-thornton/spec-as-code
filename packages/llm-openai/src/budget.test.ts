import { describe, expect, it } from "vitest";
import { OpenAICompatProvider } from "./openai.js";
import { LLM_EMPTY_COMPLETION, LLM_TIMEOUT, LLM_TRUNCATED_OUTPUT } from "@spc/llm";

// Oracle for specs/provider-budget.yaml (PB-001/PB-002, OpenAI wire):
// reasoning_effort serialization, the single-field token-limit dialect,
// the HISTORICAL temperature:0 default locked, named refusals, the
// truncation/empty split, abort-proof timeout, reasoning-token usage.

type Recorded = { body: Record<string, unknown> };

function capture(responder: () => Response): { p: OpenAICompatProvider; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const p = new OpenAICompatProvider({
    model: "m",
    apiKey: "k",
    fetchImpl: (async (_u: string, i: RequestInit) => { calls.push({ body: JSON.parse(String(i.body)) }); return responder(); }) as never,
  });
  return { p, calls };
}

import { z } from "zod";
const SCHEMA = z.strictObject({ ok: z.boolean() });
const REQ = { role: "planner" as const, requestId: "r", system: "s", prompt: "p", schema: SCHEMA, schemaName: "S" };

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 3 } } }), { status: 200 });
const empty = () => new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 4096 } }), { status: 200 });
const partial = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":' }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 4096 } }), { status: 200 });

describe("OpenAI wire expressibility (PB-001)", () => {
  it("reasoningEffort serializes as reasoning_effort", async () => {
    const calls: Recorded[] = [];
    const p = new OpenAICompatProvider({ model: "m", apiKey: "k", reasoningEffort: "low", fetchImpl: (async (_u: string, i: RequestInit) => { calls.push({ body: JSON.parse(String(i.body)) }); return ok(); }) as never });
    await p.generateStructured(REQ as never);
    expect(calls[0]!.body["reasoning_effort"]).toBe("low");
  });

  it("token limit emits ONE field under the configured dialect; default is the historical max_tokens", async () => {
    const mk = (opts: Record<string, unknown>, request = REQ) => {
      const calls: Recorded[] = [];
      const p = new OpenAICompatProvider({ model: "m", apiKey: "k", fetchImpl: (async (_u: string, i: RequestInit) => { calls.push({ body: JSON.parse(String(i.body)) }); return ok(); }) as never, ...opts });
      return { p, calls, request };
    };
    const legacy = mk({ maxTokens: 4096 });
    await legacy.p.generateStructured(legacy.request as never);
    expect(legacy.calls[0]!.body["max_tokens"]).toBe(4096);
    expect(legacy.calls[0]!.body["max_completion_tokens"]).toBeUndefined();

    const modern = mk({ maxTokens: 4096, tokenLimitField: "max_completion_tokens" });
    await modern.p.generateStructured(modern.request as never);
    expect(modern.calls[0]!.body["max_completion_tokens"]).toBe(4096);
    expect(modern.calls[0]!.body["max_tokens"]).toBeUndefined();

    // request-level override wins, still one field
    const override = mk({ maxTokens: 4096 }, { ...REQ, maxTokens: 1024 } as never);
    await override.p.generateStructured(override.request as never);
    expect(override.calls[0]!.body["max_tokens"]).toBe(1024);
  });

  it("NO config: the body is byte-compatible with history - temperature 0 present, no reasoning_effort, no token-limit field", async () => {
    const { p, calls } = capture(ok);
    await p.generateStructured(REQ as never);
    expect(calls[0]!.body["temperature"]).toBe(0);
    expect(calls[0]!.body["reasoning_effort"]).toBeUndefined();
    expect(calls[0]!.body["max_tokens"]).toBeUndefined();
    expect(calls[0]!.body["max_completion_tokens"]).toBeUndefined();
    expect(calls[0]!.body["response_format"]).toEqual({ type: "json_object" });
  });

  it("sendTemperature false OMITS temperature (the reasoning-endpoint remedy)", async () => {
    const calls: Recorded[] = [];
    const p = new OpenAICompatProvider({ model: "m", apiKey: "k", sendTemperature: false, fetchImpl: (async (_u: string, i: RequestInit) => { calls.push({ body: JSON.parse(String(i.body)) }); return ok(); }) as never });
    await p.generateStructured(REQ as never);
    expect(calls[0]!.body["temperature"]).toBeUndefined();
  });

  const refuse = (name: string, opts: Record<string, unknown>, match: RegExp) =>
    it(`construction refuses: ${name}`, () => {
      expect(() => new OpenAICompatProvider({ model: "m", apiKey: "k", fetchImpl: (async () => ok()) as never, ...opts } as never)).toThrow(match);
    });

  refuse("anthropic-only thinkingBudgetTokens", { thinkingBudgetTokens: 4096 }, /thinkingBudgetTokens|Anthropic/);
  refuse("unsupported tokenLimitField value", { tokenLimitField: "max_output_tokens" }, /tokenLimitField/);
  refuse("reasoningEffort with sendTemperature true", { reasoningEffort: "low", sendTemperature: true }, /sendTemperature/);
});

describe("OpenAI failure taxonomy (PB-002)", () => {
  it("empty content at the limit: LLM_EMPTY_COMPLETION with finish_reason and remediation", async () => {
    const p = new OpenAICompatProvider({ model: "m", apiKey: "k", maxTokens: 4096, fetchImpl: (async () => empty()) as never });
    await expect(p.generateStructured(REQ as never)).rejects.toMatchObject({ code: LLM_EMPTY_COMPLETION });
    try {
      await p.generateStructured(REQ as never);
    } catch (e) {
      expect((e as Error).message).toContain("length");
      expect((e as Error).message).toMatch(/maxTokens|reasoningEffort/);
    }
  });

  it("partial content at the limit: LLM_TRUNCATED_OUTPUT", async () => {
    const p = new OpenAICompatProvider({ model: "m", apiKey: "k", fetchImpl: (async () => partial()) as never });
    await expect(p.generateStructured(REQ as never)).rejects.toMatchObject({ code: LLM_TRUNCATED_OUTPUT });
  });

  it("timeout fires even when the fetch ignores the AbortSignal", async () => {
    const p = new OpenAICompatProvider({ model: "m", apiKey: "k", timeoutMs: 30, fetchImpl: (async () => new Promise<Response>(() => {})) as never });
    await expect(p.generateStructured(REQ as never)).rejects.toMatchObject({ code: LLM_TIMEOUT });
  });

  it("usage surfaces reasoning_tokens when present", async () => {
    const p = new OpenAICompatProvider({ model: "m", apiKey: "k", fetchImpl: (async () => ok()) as never });
    const r = await p.generateStructured(REQ as never);
    expect(r.value).toEqual({ ok: true });
    expect(r.usage.inputTokens).toBe(5);
    expect(r.usage.outputTokens).toBe(7);
    expect((r.usage as { reasoningTokens?: number }).reasoningTokens).toBe(3);
  });
});
