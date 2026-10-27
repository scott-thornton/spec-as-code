import { describe, expect, it } from "vitest";
import { configSchema } from "@spc/schema";

// Oracle for specs/provider-budget.yaml (PB-003): the config surface
// parses (union enum, dialect field, tri-state temperature, positive
// ints) and refuses garbage.

const base = { name: "anthropic" } as const;

describe("provider config surface (provider-budget)", () => {
  it("all budget/reasoning fields parse", () => {
    const parsed = configSchema.parse({
      provider: { ...base },
      maxTokens: 16384,
      timeoutMs: 600000,
      thinkingBudgetTokens: 4096,
    });
    expect(parsed.provider?.maxTokens).toBe(16384);
    expect(parsed.provider?.timeoutMs).toBe(600000);
    expect(parsed.provider?.thinkingBudgetTokens).toBe(4096);
  });

  it("reasoningEffort accepts the union enum on the openai wire", () => {
    const parsed = configSchema.parse({ provider: { name: "openai", reasoningEffort: "minimal" } });
    expect(parsed.provider?.reasoningEffort).toBe("minimal");
    const hi = configSchema.parse({ provider: { name: "openai", reasoningEffort: "xhigh" } });
    expect(hi.provider?.reasoningEffort).toBe("xhigh");
  });

  it("tokenLimitField parses the two documented dialects", () => {
    expect(configSchema.parse({ provider: { name: "openai", tokenLimitField: "max_completion_tokens" } }).provider?.tokenLimitField).toBe("max_completion_tokens");
    expect(configSchema.parse({ provider: { name: "openai" } }).provider?.tokenLimitField).toBeUndefined();
  });

  it("sendTemperature parses as optional boolean", () => {
    expect(configSchema.parse({ provider: { ...base, sendTemperature: false } }).provider?.sendTemperature).toBe(false);
    expect(configSchema.parse({ provider: base }).provider?.sendTemperature).toBeUndefined();
  });

  it("garbage is refused: negative tokens, bogus enum, bogus dialect", () => {
    expect(() => configSchema.parse({ provider: { ...base, maxTokens: -1 } })).toThrow();
    expect(() => configSchema.parse({ provider: { ...base, reasoningEffort: "ultra" } })).toThrow();
    expect(() => configSchema.parse({ provider: { ...base, tokenLimitField: "max_output_tokens" } })).toThrow();
  });
});
