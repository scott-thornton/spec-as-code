import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Oracle for specs/submission-contract-wording.yaml SCW-001 (red,
// committed pre-run): the submission contract stops binding proposals
// to the patch op - "patch" survives only as the workflow tool names.
// Source-check precedent (OCT): constant-text contracts are assertable
// at source.
const source = readFileSync(path.resolve(import.meta.dirname, "../src/harness.ts"), "utf8");

function submissionContract(): string {
  const m = /SUBMISSION_CONTRACT = `((?:[^`\\]|\\.)*)`/.exec(source);
  return m?.[1] ?? "";
}

describe("SCW-001: one word for the mechanism, another for the op", () => {
  it("the binding phrase is gone; the invariants survive", () => {
    const contract = submissionContract();
    expect(contract.length).toBeGreaterThan(0);
    // The double-duty phrase that read as patch-OP-only: absent.
    expect(contract).not.toMatch(/as patch operations in the changes array/i);
    // The proposal invariant, op-agnostic.
    expect(contract).toMatch(/changes array/i);
    expect(contract).toMatch(/never edit files directly/i);
    // The refusal and recovery, retained.
    expect(contract).toMatch(/UNMEDIATED_CHANGES/);
    expect(contract).toMatch(/spc patch build/);
    expect(contract).toMatch(/spc patch verify/);
    // Prefix-stability discipline: no braces in the constant.
    expect(contract).not.toMatch(/\{|\}/);
  });
});
