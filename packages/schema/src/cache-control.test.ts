import { describe, expect, it } from "vitest";
import { configSchema } from "./config.js";

// Oracle for specs/cache-markers.yaml (CM-002): provider.cacheControl
// is operator-expressible through the config schema - accepted when
// present, absent when not, never inherited from the root.
describe("cacheControl config field", () => {
  it("parses inside the provider section and rejects at the root", () => {
    const parsed = configSchema.parse({
      version: 1,
      provider: { name: "anthropic", model: "glm-5.3", cacheControl: true },
    });
    expect((parsed.provider as { cacheControl?: boolean }).cacheControl).toBe(true);
    expect(() => configSchema.parse({ version: 1, cacheControl: true, provider: { name: "anthropic" } } as never)).toThrow();
  });

  it("stays optional - the default config parses without it", () => {
    const parsed = configSchema.parse({});
    expect((parsed.provider as { cacheControl?: boolean }).cacheControl).toBeUndefined();
  });
});
