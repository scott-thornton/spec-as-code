import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicCompatProvider } from "./anthropic.js";

// Oracle for specs/cache-capture.yaml (CC-001, anthropic side): the
// endpoint already returns cache_read_input_tokens and
// cache_creation_input_tokens; the adapter keeps them instead of
// discarding them. Instrument completeness, not cost policy.
const schema = z.object({ answer: z.string() });

function ok(text: string, usage: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text }],
      usage,
      stop_reason: "end_turn",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function provider(fetchImpl: (url: string, init: RequestInit) => Promise<Response>): AnthropicCompatProvider {
  return new AnthropicCompatProvider({ model: "glm-4.6", apiKey: "k", fetchImpl });
}

describe("cache capture (anthropic)", () => {
  it("maps cache_read and cache_creation tokens into Usage", async () => {
    const p = provider(async () =>
      ok('{"answer":"42"}', { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 1234, cache_creation_input_tokens: 567 }),
    );
    const r = await p.generateStructured({ role: "planner", requestId: "r", system: "s", prompt: "p", schema, schemaName: "A" });
    expect(r.usage.inputTokens).toBe(1000);
    expect(r.usage.outputTokens).toBe(50);
    expect(r.usage.cacheReadTokens).toBe(1234);
    expect(r.usage.cacheCreationTokens).toBe(567);
  });

  it("omits the fields entirely when the endpoint does not report them", async () => {
    const p = provider(async () => ok('{"answer":"42"}', { input_tokens: 1000, output_tokens: 50 }));
    const r = await p.generateStructured({ role: "planner", requestId: "r", system: "s", prompt: "p", schema, schemaName: "A" });
    expect(r.usage).not.toHaveProperty("cacheReadTokens");
    expect(r.usage).not.toHaveProperty("cacheCreationTokens");
  });
});
