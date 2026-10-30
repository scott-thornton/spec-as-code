import { describe, expect, it } from "vitest";
import { buildRealProviderPair } from "./providers.js";

// Oracle for specs/runner-budget-flags.yaml: the benchmark runner
// expresses provider budget/effort/token settings through explicit CLI
// flags (the third, hand-rolled provider-construction site predates
// provider-budget - an unbudgeted reasoning-model arm is the exact
// thinking-only starvation the project retracted once), and every
// benchmark artifact carries arm provenance: the EFFECTIVE options the
// constructed providers received, after defaults - never echoed CLI
// arguments, never an API key.
describe("runner provider flags (RBF-001/002)", () => {
  it("wires all three flags into the anthropic pair and records effective provenance", () => {
    const { control, treatment, provenance } = buildRealProviderPair({
      provider: "anthropic",
      model: "glm-5.3",
      apiKey: "secret-key-material",
      timeoutMs: 300_000,
      thinkingBudgetTokens: 12_000,
      maxTokens: 16_384,
    });
    expect(provenance).toMatchObject({
      provider: "anthropic",
      model: "glm-5.3",
      timeoutMs: 300_000,
      thinkingBudgetTokens: 12_000,
      maxTokens: 16_384,
    });
    expect(control).not.toBe(treatment);
  });

  it("omitted --max-tokens retains 16384 on the anthropic branch (no confound with historical runs)", () => {
    const { provenance } = buildRealProviderPair({
      provider: "anthropic",
      apiKey: "k",
      timeoutMs: 180_000,
    });
    expect(provenance.maxTokens).toBe(16_384);
    expect(provenance.model).toBe("glm-4.6");
  });

  it("unset optionals are omitted from provenance, and reasoning effort rides along when set", () => {
    const bare = buildRealProviderPair({ provider: "anthropic", apiKey: "k", timeoutMs: 180_000 });
    expect(bare.provenance).not.toHaveProperty("thinkingBudgetTokens");
    expect(bare.provenance).not.toHaveProperty("reasoningEffort");
    const effort = buildRealProviderPair({ provider: "openai", apiKey: "k", timeoutMs: 180_000, reasoningEffort: "low", maxTokens: 8_192 });
    expect(effort.provenance).toMatchObject({ provider: "openai", model: "gpt-4.1", reasoningEffort: "low", maxTokens: 8_192 });
    expect(effort.provenance).not.toHaveProperty("thinkingBudgetTokens");
  });

  it("the openai branch without --max-tokens receives none (its own default applies) and records none", () => {
    const { provenance } = buildRealProviderPair({ provider: "openai", apiKey: "k", timeoutMs: 180_000 });
    expect(provenance).not.toHaveProperty("maxTokens");
  });

  it("provenance never contains the API key", () => {
    const { provenance } = buildRealProviderPair({ provider: "anthropic", apiKey: "secret-key-material", timeoutMs: 180_000, thinkingBudgetTokens: 4_096 });
    expect(JSON.stringify(provenance)).not.toContain("secret-key-material");
  });
});
