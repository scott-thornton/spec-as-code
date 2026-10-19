import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configSchema } from "@spc/schema";
import { verifyCriterion } from "./criteria.js";

const cwd = mkdtempSync(path.join(tmpdir(), "spc-redclass-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const DEFAULT_CONFIG = configSchema.parse({});
const property = {
  kind: "requirement",
  id: "REDCLASS-001",
  statement: "Suite runs.",
  priority: "must",
  dependsOn: [],
  acceptance: [],
} as const;

function ctx() {
  return {
    runId: "run-x",
    cwd,
    repositoryRevision: "rev1",
    config: DEFAULT_CONFIG,
    provider: null,
  };
}

describe("red evidence classification", () => {
  it("marks a contradicted run whose output shows the suite never collected tests", async () => {
    const r = await verifyCriterion(
      {
        id: "REDCLASS-001-A",
        type: "command",
        command: `node -e "console.log(' Test Files  1 failed (1)'); console.log('      Tests  no tests'); process.exit(1)"`,
        expect: { exitCode: 0 },
      },
      property as never,
      ctx(),
    );
    expect(r.evidence.outcome).toBe("contradicts");
    expect((r.evidence.payload as Record<string, unknown>).failureShape).toBe("suite-did-not-run");
  });

  it("does not mark an assertion-shaped failure", async () => {
    const r = await verifyCriterion(
      {
        id: "REDCLASS-001-B",
        type: "command",
        command: `node -e "console.log('AssertionError: expected 1 to be 2'); process.exit(1)"`,
        expect: { exitCode: 0 },
      },
      property as never,
      ctx(),
    );
    expect(r.evidence.outcome).toBe("contradicts");
    expect((r.evidence.payload as Record<string, unknown>).failureShape).toBeUndefined();
  });

  it("does not mark a supporting run", async () => {
    const r = await verifyCriterion(
      {
        id: "REDCLASS-001-C",
        type: "command",
        command: `node -e "console.log('      Tests  no tests')";`,
        expect: { exitCode: 0 },
      },
      property as never,
      ctx(),
    );
    expect(r.evidence.outcome).toBe("supports");
    expect((r.evidence.payload as Record<string, unknown>).failureShape).toBeUndefined();
  });
});
