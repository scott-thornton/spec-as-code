import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, parseStructured, validateStructured } from "./structured.js";
import { LLMError, LLM_INVALID_STRUCTURED_OUTPUT } from "./errors.js";
import { makeUsageRecord, UsageTracker } from "./usage.js";

const schema = z.strictObject({ a: z.number(), b: z.string() });

describe("structured output", () => {
  it("validates conforming data", () => {
    const r = validateStructured(schema, { a: 1, b: "x" });
    expect(r.ok).toBe(true);
  });

  it("rejects non-conforming data with issue detail", () => {
    const r = validateStructured(schema, { a: "no", c: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.length).toBeGreaterThan(0);
      expect(r.issues.some((i) => i.path === "a")).toBe(true);
    }
  });

  it("extracts JSON from fenced or wrapped model text", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a": [1,2]} hope that helps')).toEqual({ a: [1, 2] });
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("parseStructured throws typed error on schema failure", () => {
    expect(() => parseStructured(schema, '{"a": "wrong"}')).toThrow(LLMError);
    try {
      parseStructured(schema, '{"a": "wrong"}');
    } catch (e) {
      expect((e as LLMError).code).toBe(LLM_INVALID_STRUCTURED_OUTPUT);
    }
  });
});

describe("usage accounting", () => {
  it("records role, digests and tokens without secrets", () => {
    const t = new UsageTracker();
    t.record(
      makeUsageRecord("planner", "req-1", { system: "s", prompt: "p" }, '{"ok":true}', {
        model: "fake",
        durationMs: 3,
      }),
    );
    const [rec] = t.all();
    expect(rec.role).toBe("planner");
    expect(rec.inputDigest).toMatch(/^sha256:/);
    expect(rec.outputDigest).toMatch(/^sha256:/);
    expect(rec.status).toBe("success");
    expect(t.calls).toBe(1);
  });
});
