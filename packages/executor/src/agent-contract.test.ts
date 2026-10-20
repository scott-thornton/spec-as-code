import { describe, expect, it } from "vitest";
import { EXECUTOR_SYSTEM } from "./prompts.js";

describe("executor contract affordances", () => {
  it("tells the answering agent how same-file patch ops chain", () => {
    // CHK3555: the agent hand-batched same-file patches sharing one
    // baseDigest, burned an attempt on the sequential failure, and never
    // knew spc patch build --after existed. The contract is the one
    // surface every answering agent reads.
    expect(EXECUTOR_SYSTEM).toMatch(/same file/i);
    expect(EXECUTOR_SYSTEM).toContain("--after");
  });
});
