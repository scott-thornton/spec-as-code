import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type DesiredProperty } from "@spc/schema";
import { verifyCriterion } from "./criteria.js";

const cwd = mkdtempSync(path.join(tmpdir(), "spc-approval-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const property: DesiredProperty = {
  kind: "requirement",
  id: "DEP-001",
  statement: "Dependency installs cleanly.",
  priority: "must",
  dependsOn: [],
  acceptance: [],
};

function ctx(overrides: { approvedCommands?: ReadonlySet<string> } = {}) {
  return {
    runId: "run-a",
    cwd,
    repositoryRevision: "r1",
    config: DEFAULT_CONFIG,
    provider: null,
    ...overrides,
  };
}

describe("§52 command approval flow", () => {
  it("approval-class commands do not run: inconclusive evidence + approval follow-up", async () => {
    // "npm install --help" classifies as packageInstall, which defaults to
    // the approval policy - and is harmless/offline when actually run.
    const r = await verifyCriterion(
      { id: "DEP-001-A", type: "command", command: "npm install --help" },
      property,
      ctx(),
    );
    expect(r.evidence.outcome).toBe("inconclusive");
    expect(r.evidence.payload).toMatchObject({ reason: expect.stringContaining("approval") });
    expect(r.followUp?.type).toBe("approval");
    expect(r.followUp?.command).toBe("npm install --help");
    expect(r.followUp?.options?.map((o) => o.id)).toEqual(["approve", "reject"]);
    // The command must NOT have executed (no commandRun result).
    expect(r.commandRun).toBeUndefined();
  });

  it("after approval (approvedCommands), the exact command runs and can support the property", async () => {
    const r = await verifyCriterion(
      { id: "DEP-001-A", type: "command", command: "npm install --help" },
      property,
      ctx({ approvedCommands: new Set(["npm install --help"]) }),
    );
    expect(r.followUp).toBeUndefined();
    expect(r.commandRun).toBeDefined();
    expect(r.commandRun!.allowed).toBe(true);
    expect(r.evidence.outcome).toBe("supports");
    expect(r.evidence.payload).toMatchObject({ exitCode: 0 });
  });

  it("approval of one command does not approve a different approval-class command", async () => {
    const r = await verifyCriterion(
      { id: "DEP-001-A", type: "command", command: "npm install --version" },
      property,
      ctx({ approvedCommands: new Set(["npm install --help"]) }),
    );
    expect(r.commandRun).toBeUndefined();
    expect(r.followUp?.type).toBe("approval");
  });

  it("deny-class commands remain denied regardless of approvals", async () => {
    const r = await verifyCriterion(
      { id: "DEP-001-A", type: "command", command: "curl https://example.com" },
      property,
      ctx({ approvedCommands: new Set(["curl https://example.com"]) }),
    );
    expect(r.commandRun).toBeDefined();
    expect(r.commandRun!.allowed).toBe(false);
    expect(r.evidence.outcome).toBe("inconclusive");
  });
});
