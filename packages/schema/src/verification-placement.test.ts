import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import { configSchema } from "./config.js";

// Oracle for specs/host-battery-admission.yaml HBA-003-A (red,
// committed pre-run): execution.verificationPlacement is a validated
// local|ci enum defaulting to local. Today the field does not exist.
describe("HBA-003: execution.verificationPlacement (schema)", () => {
  it("defaults to local", () => {
    expect(DEFAULT_CONFIG.execution.verificationPlacement).toBe("local");
  });

  it("accepts ci", () => {
    const parsed = configSchema.parse({ ...structuredClone(DEFAULT_CONFIG), execution: { ...DEFAULT_CONFIG.execution, verificationPlacement: "ci" } });
    expect(parsed.execution.verificationPlacement).toBe("ci");
  });

  it("rejects anything else", () => {
    expect(() =>
      configSchema.parse({ ...structuredClone(DEFAULT_CONFIG), execution: { ...DEFAULT_CONFIG.execution, verificationPlacement: "bogus" } }),
    ).toThrow();
  });
});
