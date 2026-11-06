import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicCompatProvider, type ReasoningEffort } from "./anthropic.js";

// Oracle for specs/per-request-budget.yaml PRB-001 (red, committed
// pre-run): the thinking budget rides the request, flat like maxTokens,
// with the adapter's full validation discipline applied to the merged
// values. Today StructuredRequest carries no thinkingBudgetTokens and
// the adapter ignores it - legs (a)-(c) fail.
const schema = z.strictObject({ answer: z.string() });
const req = (extra: Record<string, unknown> = {}) =>
  ({ role: "executor" as const, requestId: "r", system: "s", prompt: "p", schema, schemaName: "A", ...extra });

function capturing(bodyOut: Record<string, unknown>[]): { p: () => AnthropicCompatProvider; capture: () => void } {
  const impl = (url: string, init: RequestInit) => {
    bodyOut.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return Promise.resolve(
      new Response(JSON.stringify({ content: [{ type: "text", text: '{"answer":"x"}' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }), { status: 200 }),
    );
  };
  return { p: () => new AnthropicCompatProvider({ model: "m", apiKey: "k", fetchImpl: impl }), capture: () => {} };
}

async function errOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return `${(e as { code?: string }).code ?? ""}: ${(e as Error).message}`;
  }
  return "NO_THROW";
}

describe("PRB-001: the thinking budget rides the request", () => {
  it("request thinkingBudgetTokens reaches the wire for that call only", async () => {
    const bodies: Record<string, unknown>[] = [];
    const impl = (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(new Response(JSON.stringify({ content: [{ type: "text", text: '{"answer":"x"}' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }), { status: 200 }));
    };
    const p = new AnthropicCompatProvider({ model: "m", apiKey: "k", maxTokens: 8192, fetchImpl: impl });
    await p.generateStructured(req({ thinkingBudgetTokens: 2000 }) as never);
    expect(bodies[0]!["thinking"]).toEqual({ type: "enabled", budget_tokens: 2000 });
    // For that call only: the next request without the override carries
    // no thinking key.
    await p.generateStructured(req() as never);
    expect(bodies[1]!["thinking"]).toBeUndefined();
  });

  it("request thinking budget conflicts with a configured effort control - refused before the fetch", async () => {
    const impl = () => Promise.resolve(new Response("{}", { status: 200 }));
    const p = new AnthropicCompatProvider({ model: "m", apiKey: "k", reasoningEffort: "high" as ReasoningEffort, fetchImpl: impl });
    const e = await errOf(() => p.generateStructured(req({ thinkingBudgetTokens: 2000 }) as never));
    expect(e).toMatch(/PROVIDER_CONFIG/);
    expect(e).toMatch(/mutually exclusive|pick one/i);
  });

  it("request thinking budget must be strictly below the effective max - refused before the fetch", async () => {
    const impl = () => Promise.resolve(new Response("{}", { status: 200 }));
    const p = new AnthropicCompatProvider({ model: "m", apiKey: "k", maxTokens: 4096, fetchImpl: impl });
    const e = await errOf(() => p.generateStructured(req({ thinkingBudgetTokens: 4096 }) as never));
    expect(e).toMatch(/PROVIDER_CONFIG/);
  });

  it("no overrides, no configured controls: the body carries no thinking key (byte-shape unchanged)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const impl = (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(new Response(JSON.stringify({ content: [{ type: "text", text: '{"answer":"x"}' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }), { status: 200 }));
    };
    const p = new AnthropicCompatProvider({ model: "m", apiKey: "k", fetchImpl: impl });
    await p.generateStructured(req() as never);
    expect(bodies[0]!["thinking"]).toBeUndefined();
    expect(bodies[0]!["max_tokens"]).toBe(8192);
  });
});
