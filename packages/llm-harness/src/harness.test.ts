import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { LLM_TIMEOUT } from "@spc/llm";
import { HarnessProvider } from "./harness.js";
import { HarnessStore } from "./store.js";

const schema = z.strictObject({ answer: z.string() });

function makeProvider(timeoutMs = 60_000): { provider: HarnessProvider; store: HarnessStore } {
  const root = mkdtempSync(path.join(tmpdir(), "spc-harness-"));
  const store = new HarnessStore(root);
  // A real (tiny) sleep keeps the poll loop on the macrotask queue so test
  // timers interleave; a resolved-promise sleep would starve them.
  const fastSleep = (): Promise<void> => new Promise((r) => setTimeout(r, 1));
  return { provider: new HarnessProvider(store, timeoutMs, fastSleep), store };
}

const request = {
  role: "planner" as const,
  key: "planner@1",
  requestId: "r1",
  system: "sys",
  prompt: "plan the thing",
  schema,
  schemaName: "PlannerOutput",
};

describe("harness provider", () => {
  it("writes a pending request with embedded JSON Schema and instructions", async () => {
    const { provider, store } = makeProvider();
    const seen: unknown[] = [];
    const pending = new Promise((resolve) => {
      const tick = setInterval(() => {
        const list = store.listPending();
        if (list.length > 0) {
          clearInterval(tick);
          seen.push(list[0]);
          store.answer(list[0]!.id, { answer: "ok" });
          resolve(null);
        }
      }, 1);
    });
    const result = await provider.generateStructured({ ...request, requestId: "r1" });
    await pending;
    expect(result.value).toEqual({ answer: "ok" });
    expect(result.usage.model).toBe("harness-agent");
    // The request the agent would have seen:
    const req = seen[0] as { jsonSchema: unknown; prompt: string; id: string };
    expect(req.jsonSchema).toMatchObject({ type: "object" });
    expect(req.prompt).toContain("harness instructions");
    expect(req.prompt).toContain("spc agent respond");
    // Accepted answers clear the pending file and are kept as the record.
    expect(store.listPending()).toEqual([]);
    expect(store.hasAnswer(req.id)).toBe(true);
  });

  it("request ids are role-key-invocation, incrementing per key", async () => {
    const { provider, store } = makeProvider();
    const seen: string[] = [];
    const autoAnswer = () => {
      const tick = setInterval(() => {
        for (const req of store.listPending()) {
          if (!seen.includes(req.id)) {
            seen.push(req.id);
            store.answer(req.id, { answer: "ok" });
          }
        }
        if (seen.length >= 2) clearInterval(tick);
      }, 1);
    };
    autoAnswer();
    await provider.generateStructured({ ...request, requestId: "r1" });
    await provider.generateStructured({ ...request, requestId: "r2" });
    expect(seen[0]).toBe("planner-planner@1-1");
    expect(seen[1]).toBe("planner-planner@1-2");
  });

  it("invalid answers are requeued with feedback and a corrected answer succeeds", async () => {
    const { provider, store } = makeProvider();
    let attempts = 0;
    const tick = setInterval(() => {
      const list = store.listPending();
      if (list.length === 0) return;
      attempts += 1;
      // First answer violates the schema (wrong type); second is valid.
      store.answer(list[0]!.id, attempts === 1 ? { answer: 42 } : { answer: "fixed" });
    }, 1);
    const result = await provider.generateStructured({ ...request, requestId: "r3" });
    clearInterval(tick);
    expect(result.value).toEqual({ answer: "fixed" });
    expect(attempts).toBe(2);
  });

  it("times out with a typed error naming the pending request", async () => {
    const { provider } = makeProvider(30);
    await expect(
      provider.generateStructured({ ...request, requestId: "r4" }),
    ).rejects.toMatchObject({ code: "LLM_HARNESS_RESPONSE_TIMEOUT" });
  });

  it("store.answer refuses unknown request ids", () => {
    const root = mkdtempSync(path.join(tmpdir(), "spc-harness-"));
    const store = new HarnessStore(root);
    expect(() => store.answer("nope-1", { answer: "x" })).toThrow(/no pending request/);
    rmSync(root, { recursive: true, force: true });
  });
});
