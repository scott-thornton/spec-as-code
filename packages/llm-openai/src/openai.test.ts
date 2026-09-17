import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAICompatProvider } from "./openai.js";
import { LLMError, LLM_RATE_LIMITED, LLM_TIMEOUT } from "@spc/llm";

const schema = z.strictObject({ answer: z.string() });

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function provider(fetchImpl: (url: string, init: RequestInit) => Promise<Response>): OpenAICompatProvider {
  return new OpenAICompatProvider({ model: "gpt-test", apiKey: "k", fetchImpl });
}

describe("openai-compatible provider", () => {
  it("parses structured JSON responses and usage", async () => {
    const seen: { url?: string; auth?: string; body?: unknown } = {};
    const p = provider(async (url, init) => {
      seen.url = url;
      seen.auth = (init.headers as Record<string, string>)["authorization"];
      seen.body = JSON.parse(String(init.body));
      return okResponse('{"answer":"42"}');
    });
    const r = await p.generateStructured({
      role: "verifier",
      requestId: "r",
      system: "sys",
      prompt: "prompt",
      schema,
      schemaName: "answer",
    });
    expect(r.value.answer).toBe("42");
    expect(r.usage.inputTokens).toBe(10);
    expect(seen.url).toContain("/chat/completions");
    expect(seen.auth).toBe("Bearer k");
    expect((seen.body as { temperature: number }).temperature).toBe(0);
    const userMessage = (seen.body as { messages: { role: string; content: string }[] }).messages[1]!.content;
    expect(userMessage).toContain("JSON Schema");
  });

  it("parses fenced JSON output", async () => {
    const p = provider(async () => okResponse('```json\n{"answer":"yes"}\n```'));
    const r = await p.generateStructured({
      role: "planner",
      requestId: "r",
      system: "s",
      prompt: "p",
      schema,
      schemaName: "x",
    });
    expect(r.value.answer).toBe("yes");
  });

  it("maps rate limits to typed errors", async () => {
    const p = provider(async () => new Response("slow down", { status: 429 }));
    await expect(
      p.generateStructured({ role: "planner", requestId: "r", system: "s", prompt: "p", schema, schemaName: "x" }),
    ).rejects.toMatchObject({ code: LLM_RATE_LIMITED } satisfies Partial<LLMError>);
  });

  it("maps abort/timeout to typed errors", async () => {
    const p = new OpenAICompatProvider({
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
      p.generateStructured({ role: "planner", requestId: "r", system: "s", prompt: "p", schema, schemaName: "x" }),
    ).rejects.toMatchObject({ code: LLM_TIMEOUT } satisfies Partial<LLMError>);
  });

  it("rejects schema-invalid content with typed error", async () => {
    const p = provider(async () => okResponse('{"wrong": true}'));
    await expect(
      p.generateStructured({ role: "planner", requestId: "r", system: "s", prompt: "p", schema, schemaName: "x" }),
    ).rejects.toThrow(/failed schema validation/);
  });
});
