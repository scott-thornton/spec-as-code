import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { proposedChangeSchema } from "./result.js";
import { EXECUTOR_SYSTEM } from "./prompts.js";

// Oracle for specs/executor-prompt-update-op.yaml EPO-001 (red,
// committed pre-run): the executor system prompt teaches the update op
// the schema already accepts. har take seven's model cycled on
// PATCH_BASE_MISMATCH with no current file state and no knowledge that
// update exists - the prompt's laundering clause reads as patch-only.
describe("EPO-001: the prompt teaches the op the schema accepts", () => {
  it("the system prompt names the update op with its shape, the preference clause, and the counter-laundering clause", () => {
    const prompt = EXECUTOR_SYSTEM;
    // The op and its exact shape.
    expect(prompt).toMatch(/op:\s*"update"/);
    expect(prompt).toMatch(/update/);
    // Patches stay preferred when current state IS in context.
    expect(prompt).toMatch(/prefer patch ops/i);
    // Update is sanctioned when composition is impractical without state.
    expect(prompt).toMatch(/impractical|wholesale|full-content/i);
    // The laundering counterweight: update never forces a refused patch
    // without re-reading.
    expect(prompt).toMatch(/refused.*re-read|re-read.*refused|without first re-read/i);
  });

  it("the schema accepts an update-op change entry - prompt and schema cannot drift apart", () => {
    const parsed = proposedChangeSchema.safeParse({ op: "update", path: "src/a.ts", content: "export const a = 1;\n" });
    expect(parsed.success).toBe(true);
  });
});
