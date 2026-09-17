import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicCompatProvider } from "./anthropic.js";
import { LLM_RATE_LIMITED, LLM_TIMEOUT } from "@spc/llm";

const schema = z.strictObject({ answer: z.string() });

function okResponse(text: string, usage = { input_tokens: 12, output_tokens: 6 }): Response {
  return new Response(
    JSON.stringify({
      content: [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text },
      ],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function provider(fetchImpl: (url: string, init: RequestInit) => Promise<Response>): AnthropicCompatProvider {
  return new AnthropicCompatProvider({ model: "glm-4.6", apiKey: "k", fetchImpl });
}

describe("anthropic-compatible provider", () => {
  it("sends Messages-API shape with schema hint, x-api-key header, and parses text blocks", async () => {
    const seen: { url?: string; key?: string; body?: Record<string, unknown> } = {};
    const p = provider(async (url, init) => {
      seen.url = url;
      const headers = init.headers as Record<string, string>;
      seen.key = headers["x-api-key"];
      seen.body = JSON.parse(String(init.body));
      return okResponse('{"answer":"42"}');
    });
    const r = await p.generateStructured({
      role: "planner",
      requestId: "r",
      system: "sys",
      prompt: "do the thing",
      schema,
      schemaName: "Answer",
    });
    expect(r.value.answer).toBe("42");
    expect(r.usage.inputTokens).toBe(12);
    expect(seen.url).toContain("/v1/messages");
    expect(seen.key).toBe("k");
    const content = ((seen.body!.messages as { content: string }[])[0]!.content);
    expect(content).toContain("JSON Schema");
    expect(content).toContain("do the thing");
    expect(seen.body!.system).toBe("sys");
    expect(seen.body!.max_tokens).toBeGreaterThan(0);
    expect(seen.body!.temperature).toBeUndefined();
  });

  it("parses fenced JSON text blocks", async () => {
    const p = provider(async () => okResponse('```json\n{"answer":"yes"}\n```'));
    const r = await p.generateStructured({
      role: "executor", requestId: "r", system: "s", prompt: "p", schema, schemaName: "x",
    });
    expect(r.value.answer).toBe("yes");
  });

  it("maps rate limits and timeouts to typed errors", async () => {
    const limited = provider(async () => new Response("slow down", { status: 429 }));
    await expect(
      limited.generateStructured({ role: "planner", requestId: "r", system: "s", prompt: "p", schema, schemaName: "x" }),
    ).rejects.toMatchObject({ code: LLM_RATE_LIMITED });

    const slow = new AnthropicCompatProvider({
      model: "m",
      apiKey: "k",
      timeoutMs: 5,
      fetchImpl: () =>
        new Promise((_resolve, reject) => {
          const e = new Error("aborted") as Error & { name: string };
          e.name = "AbortError";
          setTimeout(() => reject(e), 20);
        }),
    });
    await expect(
      slow.generateStructured({ role: "planner", requestId: "r", system: "s", prompt: "p", schema, schemaName: "x" }),
    ).rejects.toMatchObject({ code: LLM_TIMEOUT });
  });

  it("no text blocks -> typed provider failure", async () => {
    const p = provider(async () => new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "…" }] }), { status: 200 }));
    await expect(
      p.generateStructured({ role: "planner", requestId: "r", system: "s", prompt: "p", schema, schemaName: "x" }),
    ).rejects.toThrow(/no text blocks/);
  });
});
