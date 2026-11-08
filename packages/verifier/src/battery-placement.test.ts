import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

// Oracle for specs/host-battery-admission.yaml HBA-003-B (red,
// committed pre-run): under execution.verificationPlacement=ci, a
// local verify DEFERS command criteria as inconclusive with an
// admission-deferred reason - never executed, never satisfied - while
// file assertions still evaluate. Today the placement field is
// unread: the command executes and the deferral assertions fail.
const root = mkdtempSync(path.join(tmpdir(), "spc-hba-place-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});

mkdirSync(root, { recursive: true });
writeFileSync(path.join(root, "ok.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(path.join(root, "fact.txt"), "x\n", "utf8");
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });

const CI_CONFIG = {
  ...DEFAULT_CONFIG,
  execution: { ...DEFAULT_CONFIG.execution, verificationPlacement: "ci" },
} as typeof DEFAULT_CONFIG;

async function run(criterion: unknown, propertyId: string): Promise<{ outcome: string; payload: Record<string, unknown> }> {
  const property = { id: propertyId, statement: "Gate.", priority: "must", acceptance: [criterion] } as never;
  const result = await verifyCriterion(criterion as never, property, {
    runId: "hba-place", cwd: root, repositoryRevision: "0".repeat(40),
    config: CI_CONFIG, provider: null,
  });
  return { outcome: result.evidence.outcome, payload: result.evidence.payload as Record<string, unknown> };
}

describe("HBA-003: ci placement defers command criteria locally", () => {
  it("a command criterion under ci placement: inconclusive with admission-deferred - never executed", async () => {
    const r = await run({ id: "HBAF-001-A", type: "command", command: "node ok.cjs", discriminating: true }, "HBAF-001");
    expect(r.outcome).toBe("inconclusive");
    expect(r.payload["failureShape"]).toBe("admission-deferred");
  });

  it("a file criterion under ci placement still evaluates (no subprocess, no deferral)", async () => {
    const r = await run({ id: "HBAF-002-A", type: "file", path: "fact.txt", assert: { exists: true }, discriminating: true }, "HBAF-002");
    expect(r.outcome).toBe("supports");
  });

  it("local placement (the default): the command criterion executes normally", async () => {
    const property = { id: "HBAF-003", statement: "Gate.", priority: "must", acceptance: [{ id: "HBAF-003-A", type: "command", command: "node ok.cjs", discriminating: true }] } as never;
    const result = await verifyCriterion((property as never as { acceptance: unknown[] }).acceptance[0] as never, property, {
      runId: "hba-place", cwd: root, repositoryRevision: "0".repeat(40),
      config: DEFAULT_CONFIG, provider: null,
    });
    expect(result.evidence.outcome).toBe("supports");
  });
});
