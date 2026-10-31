import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAICompatProvider } from "./openai.js";

// Oracle for specs/cache-capture.yaml (CC-001, openai side): the dialect
// reports cached input tokens as usage.prompt_tokens_details.cached_tokens;
// the adapter maps them to cacheReadTokens. There is no creation
// concept on this wire - cacheCreationTokens stays absent.
const schema = z.strictObject({ answer: z.string() });

function ok(content: string, usage: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function provider(fetchImpl: (url: string, init: RequestInit) => Promise<Response>): OpenAICompatProvider {
  return new OpenAICompatProvider({ model: "gpt-test", apiKey: "k", fetchImpl });
}

describe("cache capture (openai)", () => {
  it("maps prompt_tokens_details.cached_tokens into cacheReadTokens", async () => {
    const p = provider(async () =>
      ok('{"answer":"42"}', { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 99 } }),
    );
    const r = await p.generateStructured({ role: "planner", requestId: "r", system: "s", prompt: "p", schema, schemaName: "A" });
    expect(r.usage.inputTokens).toBe(1000);
    expect(r.usage.cacheReadTokens).toBe(99);
    expect(r.usage).not.toHaveProperty("cacheCreationTokens");
  });

  it("omits the fields when the endpoint does not report details", async () => {
    const p = provider(async () => ok('{"answer":"42"}', { prompt_tokens: 1000, completion_tokens: 5 }));
    const r = await p.generateStructured({ role: "planner", requestId: "r", system: "s", prompt: "p", schema, schemaName: "A" });
    expect(r.usage).not.toHaveProperty("cacheReadTokens");
    expect(r.usage).not.toHaveProperty("cacheCreationTokens");
  });
});
