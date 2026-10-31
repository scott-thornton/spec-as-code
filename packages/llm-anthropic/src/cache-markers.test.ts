import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicCompatProvider } from "./anthropic.js";

// Oracle for specs/cache-markers.yaml (CM-001): with cacheControl on,
// the wire carries markered blocks - system as a block array with
// cache_control ephemeral, the schema hint as its own leading cached
// block ahead of the prompt. Off, the wire is byte-identical to today:
// string system, single-string content with the prompt first, and no
// cache_control anywhere in the body.
const schema = z.object({ answer: z.string() });

function ok(text: string): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text }],
      usage: { input_tokens: 12, output_tokens: 6 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface Captured {
  system?: unknown;
  content?: unknown;
  raw: string;
}

async function capture(cacheControl?: boolean): Promise<Captured> {
  let seen: Record<string, unknown> = {};
  const p = new AnthropicCompatProvider({
    model: "glm-4.6",
    apiKey: "k",
    ...(cacheControl !== undefined ? { cacheControl } : {}),
    fetchImpl: async (_url, init) => {
      seen = JSON.parse(String(init.body));
      return ok('{"answer":"42"}');
    },
  });
  const r = await p.generateStructured({
    role: "executor", requestId: "r", system: "ROLE SYSTEM", prompt: "do the thing", schema, schemaName: "Answer",
  });
  expect(r.value.answer).toBe("42");
  return {
    system: seen.system,
    content: (seen.messages as { content: unknown }[])[0]?.content,
    raw: JSON.stringify(seen),
  };
}

describe("cache markers (anthropic wire)", () => {
  it("cacheControl: true sends a markered system block and a schema-first cached block", async () => {
    const c = await capture(true);
    const system = c.system as { type: string; text: string; cache_control?: { type: string } }[];
    expect(Array.isArray(system)).toBe(true);
    expect(system[0]!.type).toBe("text");
    expect(system[0]!.text).toBe("ROLE SYSTEM");
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    const blocks = c.content as { type: string; text: string; cache_control?: { type: string } }[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toHaveLength(2);
    // Stable-before-variable, structurally: the schema hint leads,
    // markered; the prompt follows, unmarked.
    expect(blocks[0]!.text).toContain("JSON Schema");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1]!.text).toBe("do the thing");
    expect(blocks[1]!.cache_control).toBeUndefined();
  });

  it("default (absent) and explicit false are byte-identical to today: string system, prompt-first single string, no cache_control anywhere", async () => {
    for (const c of [await capture(), await capture(false)]) {
      expect(typeof c.system).toBe("string");
      expect(c.system).toBe("ROLE SYSTEM");
      expect(typeof c.content).toBe("string");
      expect((c.content as string).startsWith("do the thing")).toBe(true);
      expect((c.content as string)).toContain("JSON Schema");
      expect(c.raw).not.toContain("cache_control");
    }
  });

  it("the markers ride alongside budget mode unchanged", async () => {
    let seen: Record<string, unknown> = {};
    const p = new AnthropicCompatProvider({
      model: "glm-5.3", apiKey: "k", maxTokens: 16384, thinkingBudgetTokens: 4096, cacheControl: true,
      fetchImpl: async (_url, init) => {
        seen = JSON.parse(String(init.body));
        return ok('{"answer":"42"}');
      },
    });
    await p.generateStructured({
      role: "executor", requestId: "r", system: "s", prompt: "p", schema, schemaName: "A",
    });
    expect(seen.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect((seen.system as { cache_control?: unknown }[])[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(Array.isArray(seen.messages !== undefined ? (seen.messages as { content: unknown }[])[0]!.content : null)).toBe(true);
  });
});
