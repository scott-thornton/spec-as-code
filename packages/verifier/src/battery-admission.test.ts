import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@spc/schema";
import { verifyCriterion } from "./criteria.js";

// Oracle for specs/host-battery-admission.yaml HBA-001/HBA-002/HBA-C01
// (red, committed pre-run): fresh command-criterion executions acquire
// a host admission lock (per-user per-host, outside every repo); a
// held lock refuses - inconclusive with failureShape admission-refused,
// never contradicted, never a launched subprocess. The holder is a
// REAL flock on the lock path (resolved via the runtime package's
// fs-ext, the same native module the platform lock uses), so the
// contention is kernel-arbitrated, not simulated. Today no admission
// seam exists and every refusal leg below fails: the command executes.
const root = mkdtempSync(path.join(tmpdir(), "spc-hba-"));
const lockPath = path.join(root, "host-admission.lock");
const repoB = path.join(root, "repo-b");
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
  delete process.env.SPC_ADMISSION_LOCK;
});

mkdirSync(repoB, { recursive: true });
writeFileSync(path.join(repoB, "ok.cjs"), "require('fs').writeFileSync('ran.marker','1');process.exit(0);\n", "utf8");
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repoB });

/** A real kernel flock holder on the lock path (the runtime package's fs-ext). */
function startHolder(): ReturnType<typeof spawn> {
  const runtimeDist = path.resolve(import.meta.dirname, "../../runtime/dist");
  const script = `
    const { createRequire } = require("node:module");
    const fsExt = createRequire(${JSON.stringify(runtimeDist)})( "fs-ext");
    const fs = require("node:fs");
    const fd = fs.openSync(${JSON.stringify(lockPath)}, "w");
    fsExt.flockSync(fd, "exnb");
    console.log("HELD");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.once("data", () => {});
  return child;
}

async function runCommandCriterion(extraEnv: NodeJS.ProcessEnv = {}): Promise<{ outcome: string; payload: Record<string, unknown> }> {
  const criterion = { id: "HBAF-001-A", type: "command", command: "node ok.cjs", discriminating: true } as never;
  const property = { id: "HBAF-001", statement: "Gate.", priority: "must", acceptance: [criterion] } as never;
  const prev = { ...process.env, ...extraEnv };
  process.env.SPC_ADMISSION_LOCK = extraEnv.SPC_ADMISSION_LOCK ?? lockPath;
  try {
    const result = await verifyCriterion(criterion, property, {
      runId: "hba-test", cwd: repoB, repositoryRevision: "0".repeat(40),
      config: DEFAULT_CONFIG, provider: null,
    });
    return { outcome: result.evidence.outcome, payload: result.evidence.payload as Record<string, unknown> };
  } finally {
    process.env.SPC_ADMISSION_LOCK = prev.SPC_ADMISSION_LOCK;
    delete process.env.SPC_ADMISSION_LOCK;
  }
}

describe("HBA-001/HBA-002: host admission on fresh criterion execution", () => {
  it("a held host lock: the criterion in a DIFFERENT repository refuses - inconclusive, admission-refused, never contradicted", { timeout: 30_000 }, async () => {
    const holder = startHolder();
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await runCommandCriterion();
      expect(r.outcome).toBe("inconclusive");
      expect(r.payload["failureShape"]).toBe("admission-refused");
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("no subprocess launches on refusal: the command's marker file is absent", { timeout: 30_000 }, async () => {
    rmSync(path.join(repoB, "ran.marker"), { force: true });
    const holder = startHolder();
    await new Promise((r) => setTimeout(r, 500));
    try {
      await runCommandCriterion();
      expect(existsSync(path.join(repoB, "ran.marker"))).toBe(false);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("control: with the lock free, the same criterion executes and supports", { timeout: 30_000 }, async () => {
    const holder = startHolder();
    await new Promise((r) => setTimeout(r, 500));
    holder.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    const r = await runCommandCriterion();
    expect(r.outcome).toBe("supports");
    expect(existsSync(path.join(repoB, "ran.marker"))).toBe(true);
  });
});

describe("HBA-C01: admission seam placement", () => {
  it("file criteria never acquire the lock (no subprocess): a file criterion evaluates while the lock is held", async () => {
    writeFileSync(path.join(repoB, "fact.txt"), "x\n", "utf8");
    const criterion = { id: "HBAF-002-A", type: "file", path: "fact.txt", assert: { exists: true }, discriminating: true } as never;
    const property = { id: "HBAF-002", statement: "Gate.", priority: "must", acceptance: [criterion] } as never;
    const holder = startHolder();
    await new Promise((r) => setTimeout(r, 500));
    try {
      process.env.SPC_ADMISSION_LOCK = lockPath;
      const result = await verifyCriterion(criterion, property, {
        runId: "hba-test", cwd: repoB, repositoryRevision: "0".repeat(40),
        config: DEFAULT_CONFIG, provider: null,
      });
      expect(result.evidence.outcome).toBe("supports");
    } finally {
      delete process.env.SPC_ADMISSION_LOCK;
      holder.kill("SIGKILL");
    }
  });
});
