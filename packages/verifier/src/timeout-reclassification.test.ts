import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// specs/host-battery-admission test isolation: these suites execute
// command criteria through the real executor, which now acquires the
// HOST admission lock. Unit tests are not host batteries - pin a
// per-suite lock path so (a) sibling vitest files running concurrently
// never contend on the default host lock, and (b) a parent criterion
// process holding the host lock (self-referential criteria commands)
// never refuses these suites' inner executions.
const SPC_ADMISSION_TEST_LOCK = mkdtempSync(path.join(tmpdir(), "spc-adm-")) + "/admission.lock";
process.env.SPC_ADMISSION_LOCK = SPC_ADMISSION_TEST_LOCK;
afterAll(() => { delete process.env.SPC_ADMISSION_LOCK; rmSync(SPC_ADMISSION_TEST_LOCK, { force: true }); });
import { DEFAULT_CONFIG } from "@spc/schema";
import { verifyCriterion } from "./criteria.js";

// Oracle for specs/timeout-reclassification.yaml TC-001 (red,
// committed pre-run): a command-budget timeout is environment class -
// one recorded fresh retry, then honest inconclusive (budget-timeout),
// never contradicted. Supersedes FC-003's timeout clause on four field
// exhibits of false-red machine deaths. Today timeouts stay
// contradicted with no retry.
const root = mkdtempSync(path.join(tmpdir(), "spc-tc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function run(command: string, timeoutMs: number) {
  const criterion = {
    id: "TCF-001-A",
    type: "command",
    command,
    discriminating: true,
    timeoutMs,
  } as never;
  const property = {
    id: "TCF-001",
    statement: "Gate.",
    priority: "must",
    acceptance: [criterion],
  } as never;
  const result = await verifyCriterion(criterion, property, {
    runId: "tc-test",
    cwd: root,
    repositoryRevision: "0".repeat(40),
    config: DEFAULT_CONFIG,
    provider: null,
  });
  return { outcome: result.evidence.outcome, payload: result.evidence.payload as Record<string, unknown> };
}

describe("timeout reclassification (timeout-reclassification)", () => {
  it("a transient environment timeout passes on the recorded retry: supports, attempts 2", { timeout: 30_000 }, async () => {
    // First invocation creates the marker and outlives the budget; the
    // retry sees the marker and exits 0 instantly.
    writeFileSync(
      path.join(root, "transient.cjs"),
      'const fs = require("fs");\nif (fs.existsSync("marker")) process.exit(0);\nfs.writeFileSync("marker", "1");\nsetTimeout(() => {}, 30000);\n',
      "utf8",
    );
    const r = await run("node transient.cjs", 1200);
    expect(r.outcome).toBe("supports");
    expect(r.payload["attempts"]).toBe(2);
    expect(r.payload["firstAttemptTimedOut"]).toBe(true);
  });

  it("a persistent wedge: inconclusive with budget-timeout shape, attempts 2 - never contradicted", { timeout: 30_000 }, async () => {
    writeFileSync(path.join(root, "wedge.cjs"), "setTimeout(() => {}, 30000);\n", "utf8");
    const r = await run("node wedge.cjs", 1000);
    expect(r.outcome).toBe("inconclusive");
    expect(r.payload["failureShape"]).toBe("budget-timeout");
    expect(r.payload["attempts"]).toBe(2);
  });

  it("an assertion failure is unchanged: contradicted, single attempt, no retry", async () => {
    writeFileSync(path.join(root, "fail.cjs"), "process.exit(1);\n", "utf8");
    const r = await run("node fail.cjs", 10_000);
    expect(r.outcome).toBe("contradicts");
    expect(r.payload["attempts"]).toBeUndefined();
  });
});
