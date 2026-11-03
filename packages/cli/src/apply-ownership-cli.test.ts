import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileSpecSource } from "@spc/core";

// Oracle for specs/apply-ownership.yaml AO-008 (pre-execution gate):
// CLI integration tests for apply ownership. The fixture compiles the
// spec through the same compiler apply uses (real digest) and configures
// the harness provider so a started apply hangs on its executor request.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-ao-cli-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});

const SPEC_YAML = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: ao-cli
  title: T
goal: G
requirements:
  - id: T-001
    statement: S
    priority: must
    acceptance:
      - id: T-001-A
        type: file
        path: out.txt
        assert:
          exists: true
`;

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc", "plans"), { recursive: true });
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
writeFileSync(path.join(root, "specs", "spec.yaml"), SPEC_YAML, "utf8");
writeFileSync(
  path.join(root, ".spc", "config.yaml"),
  "version: 1\nprovider:\n  name: harness\nexecution:\n  requirePlanApproval: false\n  inPlace: true\nverification:\n  requireRedPhase: false\n",
  "utf8",
);
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

const compiled = compileSpecSource(SPEC_YAML, "spec.yaml");
if (!compiled.ok || !compiled.ir) throw new Error("fixture spec does not compile");
writeFileSync(
  path.join(root, ".spc", "plans", "plan-test.json"),
  JSON.stringify({
    apiVersion: "spc.dev/v1alpha1", kind: "Plan",
    metadata: { id: "plan-test", createdAt: new Date().toISOString() },
    spec: { id: "ao-cli", digest: compiled.ir.digest },
    repository: { revision: git(["rev-parse", "HEAD"]).trim(), snapshotDigest: "sha256:" + "0".repeat(64) },
    tasks: [{ id: "T001", title: "t", kind: "modify", intent: "i", dependsOn: [], satisfies: ["T-001"], targets: { write: ["out.txt"] } }],
  }),
  "utf8",
);

describe("AO-001 CLI: refusal message shape", () => {
  it("a second apply in the same worktree while one is running exits non-zero with APPLY_ALREADY_RUNNING naming the holder", { timeout: 45000 }, async () => {
    // Start a hanging apply in the background (harness provider: the
    // executor request queues and the apply waits for an answer).
    const child = spawn(process.execPath, [CLI, "apply", ".spc/plans/plan-test.json"], { cwd: root, stdio: "pipe" });
    await new Promise((r) => setTimeout(r, 3000));
    // Try a second apply - it must refuse with the ownership diagnostic.
    const second = sh(["apply", ".spc/plans/plan-test.json"]);
    expect(second.status).not.toBe(0);
    expect(second.stdout).toMatch(/APPLY_ALREADY_RUNNING/);
    // Refusal names the holder and suggests the remedies
    expect(second.stdout).toMatch(/spc apply owner/);
    // Clean up the hanging process and any safety block it leaves
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 500));
    sh(["apply", "recover"]);
  });
});

describe("AO-006 CLI: owner inspection", () => {
  it("spc apply owner reports the three authorities distinctly", { timeout: 10000 }, () => {
    const r = sh(["apply", "owner"]);
    expect(r.status).toBe(0);
    // The three authority levels are labelled
    expect(r.stdout).toMatch(/lock/i);
    expect(r.stdout).toMatch(/safety/i);
    expect(r.stdout).toMatch(/advisory|metadata/i);
  });
});

describe("AO-006 CLI: --allow-concurrent removed", () => {
  it("the --allow-concurrent flag is rejected with a migration diagnostic", { timeout: 10000 }, () => {
    const r = sh(["apply", "--allow-concurrent", ".spc/plans/plan-test.json"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/removed|migration|no longer/i);
  });
});

describe("AO-005 CLI: recover command", () => {
  it("spc apply recover exists and reports status even with no active block", { timeout: 10000 }, () => {
    const r = sh(["apply", "recover"]);
    expect(r.status).toBe(0);
  });
});
