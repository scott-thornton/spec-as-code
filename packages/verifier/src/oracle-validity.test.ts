import { describe, expect, it } from "vitest";
import { classifyOracleValidity, isEligibleRed, oraclePathsFromCommand } from "./oracle-validity.js";

// Oracle for specs/oracle-validity.yaml (OV-001, OV-003 consumer side):
// classification fails to uncertainty - only a transform failure
// unambiguously located in the oracle's own source is oracle-invalid -
// and eligibility is derived at consumption for legacy records.

// The observed envelope (esbuild via vitest, from the 2026-10-24
// incident: the unquoted BSF-001 key).
const transformInOracle = (file: string) => `Transform failed with 1 error:
${file}:109:25: ERROR: Expected "}" but found "-"
  Plugin: vite:esbuild
  File: ${file}
`;
const SINGLE = "vitest run src/board-staleness.test.ts";

describe("oracle path extraction", () => {
  it("collects test-file tokens across shell segments", () => {
    expect(oraclePathsFromCommand("pnpm --filter @spc/cli exec vitest run src/a.test.ts")).toEqual(["src/a.test.ts"]);
    expect(
      oraclePathsFromCommand("pnpm --filter @spc/cli... build > /dev/null && pnpm --filter @spc/cli exec vitest run src/a.test.ts"),
    ).toEqual(["src/a.test.ts"]);
    expect(oraclePathsFromCommand("node --test src/x.test.mjs")).toEqual(["src/x.test.mjs"]);
    expect(oraclePathsFromCommand("vitest run src/a.test.ts src/b.test.ts")).toEqual(["src/a.test.ts", "src/b.test.ts"]);
    expect(oraclePathsFromCommand("node --test src/")).toEqual([]);
  });
});

describe("classification (OV-001)", () => {
  it("a transform failure naming the oracle source is oracle-invalid", () => {
    const r = classifyOracleValidity(SINGLE, transformInOracle("/repo/packages/cli/src/board-staleness.test.ts"));
    expect(r.invalid).toBe(true);
  });

  it("a legitimate missing-implementation failure is never oracle-invalid", () => {
    const out = `Error: Cannot find module '/repo/src/implementation.ts' imported from src/oracle.test.ts
    at ...`;
    expect(classifyOracleValidity(SINGLE, out).invalid).toBe(false);
  });

  it("a transform failure naming a DIFFERENT file (transitive import) stays unclassified", () => {
    const r = classifyOracleValidity(SINGLE, transformInOracle("/repo/src/helpers/broken-helper.ts"));
    expect(r.invalid).toBe(false);
  });

  it("diagnostics naming mixed files stay unclassified (no coercion)", () => {
    const out = `Transform failed with 2 errors:
/repo/src/helpers/broken-helper.ts:1:1: ERROR: boom
/repo/packages/cli/src/board-staleness.test.ts:109:25: ERROR: Expected "}" but found "-"
`;
    expect(classifyOracleValidity(SINGLE, out).invalid).toBe(false);
  });

  it("a command naming multiple test files never classifies", () => {
    const out = transformInOracle("/repo/packages/cli/src/a.test.ts");
    expect(classifyOracleValidity("vitest run src/a.test.ts src/b.test.ts", out).invalid).toBe(false);
  });

  it("unknown runner output stays unclassified", () => {
    expect(classifyOracleValidity(SINGLE, "some novel runner crash").invalid).toBe(false);
    expect(classifyOracleValidity(SINGLE, "").invalid).toBe(false);
  });
});

describe("eligibility as a property of evidence (OV-003)", () => {
  const base = { id: "EV-0001", runId: "r", propertyRefs: [], kind: "command" as const, outcome: "contradicts" as const, producer: { type: "runtime" as const }, timestamp: "t", repositoryRevision: "0" };

  it("a stamped-invalid red is ineligible", () => {
    expect(isEligibleRed({ ...base, payload: { command: SINGLE, oracleValidity: "invalid" } })).toBe(false);
  });

  it("a legacy red carrying the invalid envelope is ineligible BY DERIVATION at consumption", () => {
    // No oracleValidity field (pre-classification record) - the cached
    // red cannot bypass the new semantics.
    const legacy = {
      ...base,
      payload: { command: SINGLE, stderr: transformInOracle("/repo/packages/cli/src/board-staleness.test.ts") },
    };
    expect(isEligibleRed(legacy)).toBe(false);
  });

  it("a legacy red with an eligible failure shape derives eligible", () => {
    const legacy = { ...base, payload: { command: SINGLE, stderr: "AssertionError: expected 1 to be 2" } };
    expect(isEligibleRed(legacy)).toBe(true);
  });

  it("a legacy red without derivable diagnostics stays eligible - no manufactured certainty", () => {
    const legacy = { ...base, payload: {} };
    expect(isEligibleRed(legacy)).toBe(true);
  });

  it("non-contradicted records are not red-eligibility questions (never invalid)", () => {
    expect(isEligibleRed({ ...base, outcome: "supports", payload: {} })).toBe(true);
  });
});
