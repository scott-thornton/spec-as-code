import { describe, expect, it } from "vitest";
import { configSchema } from "@spc/schema";

describe("allowDirtyPaths schema", () => {
  it("accepts an optional allowDirtyPaths array under execution", () => {
    const parsed = configSchema.safeParse({
      version: 1,
      execution: { allowDirtyPaths: [".env", "config/local.yaml"] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.execution.allowDirtyPaths).toEqual([".env", "config/local.yaml"]);
    }
  });

  it("defaults to undefined (the feature is opt-in)", () => {
    const parsed = configSchema.parse({});
    expect(parsed.execution.allowDirtyPaths).toBeUndefined();
  });
});
