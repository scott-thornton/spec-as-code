import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Oracle for specs/timer-hygiene.yaml NT-001 (red, committed pre-run):
// a completed non-streaming call leaves no timers behind. The
// timeoutRace inner setTimeout is never cleared today, so a child that
// succeeds quickly under a large timeoutMs lingers for the full
// timeoutMs before exiting. We measure the child's total lifetime.
describe("NT-001: a completed call leaves no timers behind", () => {
  it("a fast successful call under timeoutMs 8000: the child process exits promptly, not at the timer horizon", { timeout: 30_000 }, async () => {
    const childScript = `
      const { AnthropicCompatProvider } = require("${process.cwd()}/dist/anthropic.js");
      const { z } = require("zod");
      const p = new AnthropicCompatProvider({
        model: "m", apiKey: "k", timeoutMs: 8000,
        fetchImpl: async () => new Response(
          JSON.stringify({ content: [{ type: "text", text: '{"answer":"x"}' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }),
          { status: 200 },
        ),
      });
      p.generateStructured({ role: "executor", requestId: "r", system: "s", prompt: "p", schema: z.strictObject({ answer: z.string() }), schemaName: "A" })
        .then((r) => { if (!r.value || r.value.answer !== "x") { console.error("BAD_RESULT"); process.exit(3); } console.log("OK"); })
        .catch((e) => { console.error("CALL_FAILED", e.message); process.exit(4); });
    `;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ["-e", childScript], { encoding: "utf-8", timeout: 25_000 });
    const elapsed = Date.now() - t0;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("OK");
    // Before the fix the child lingers ~timeoutMs (8000) after the
    // ~instant call; after, it exits immediately. 4s cleanly separates
    // the two worlds.
    expect(elapsed).toBeLessThan(4_000);
  });
});
