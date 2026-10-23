import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@spc/schema";
import { verifyCriterion } from "./criteria.js";

// Oracle for specs/verification-preparation.yaml (VP-002): with
// environmentReady explicitly false, command criteria do not execute and
// report inconclusive - an invalid observation is never a contradiction.
const root = mkdtempSync(path.join(tmpdir(), "spc-envclass-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const criterion = {
  id: "VPC-001-A",
  type: "command",
  command: "node write-marker.cjs",
  discriminating: true,
} as never;
const property = {
  id: "VPC-001",
  statement: "Marker written.",
  priority: "must",
  acceptance: [criterion],
} as never;

const config = DEFAULT_CONFIG;

writeFileSync(path.join(root, "write-marker.cjs"), "require('node:fs').writeFileSync('marker.txt', 'ran');\n", "utf8");

describe("environment classification (VP-002)", () => {
  it("environmentReady false: no execution, inconclusive, never contradicted", async () => {
    const result = await verifyCriterion(criterion, property, {
      runId: "vp-test",
      cwd: root,
      repositoryRevision: "0".repeat(40),
      config,
      provider: null,
      environmentReady: false,
    });
    expect(result.evidence.outcome).toBe("inconclusive");
    expect(existsSync(path.join(root, "marker.txt"))).toBe(false);
    const payload = result.evidence.payload as { reason?: string };
    expect(payload.reason ?? "").toMatch(/environment/i);
  });

  it("flag absent: the criterion executes normally", async () => {
    const result = await verifyCriterion(criterion, property, {
      runId: "vp-test",
      cwd: root,
      repositoryRevision: "0".repeat(40),
      config,
      provider: null,
    });
    expect(result.evidence.outcome).toBe("supports");
    expect(existsSync(path.join(root, "marker.txt"))).toBe(true);
  });
});
