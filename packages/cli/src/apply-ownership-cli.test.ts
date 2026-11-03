import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/apply-ownership.yaml AO-008 (pre-execution gate):
// CLI integration tests for apply ownership. These MUST fail against
// the current implementation - the refusal message, owner inspection
// command, and --allow-concurrent removal do not exist.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-ao-cli-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});
function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc", "plans"), { recursive: true });
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
writeFileSync(path.join(root, "specs", "spec.yaml"), 'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: ao-cli\n  title: T\ngoal: G\nrequirements:\n  - id: T-001\n    statement: S\n    priority: must\n    acceptance:\n      - id: T-001-A\n        type: file\n        path: out.txt\n        assert:\n          exists: true\n', "utf8");
writeFileSync(path.join(root, ".spc", "config.yaml"), "version: 1\nprovider:\n  name: fake\n");
writeFileSync(path.join(root, "out.txt"), "done\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);
writeFileSync(
  path.join(root, ".spc", "plans", "plan-test.json"),
  JSON.stringify({
    apiVersion: "spc.dev/v1alpha1", kind: "Plan",
    metadata: { id: "plan-test", createdAt: new Date().toISOString() },
    spec: { id: "ao-cli", digest: "sha256:" + "0".repeat(64) },
    repository: { revision: "0".repeat(40), snapshotDigest: "sha256:" + "0".repeat(64) },
    tasks: [{ id: "T001", title: "t", kind: "modify", intent: "i", dependsOn: [], satisfies: ["T-001"], targets: { write: ["out.txt"] } }],
  }),
  "utf8",
);

describe("AO-001 CLI: refusal message shape", () => {
  it("a second apply in the same worktree while one is running exits non-zero with APPLY_ALREADY_RUNNING naming the holder", { timeout: 30000 }, () => {
    // Start a hanging apply in the background
    const child = spawn(process.execPath, [CLI, "apply", ".spc/plans/plan-test.json"], { cwd: root, stdio: "pipe" });
    // Wait for it to start
    setTimeout(() => {}, 3000);
    // Try a second apply - it should refuse
    const second = sh(["apply", ".spc/plans/plan-test.json"]);
    // With the correct implementation: second.status > 0 and the message contains APPLY_ALREADY_RUNNING
    // With the broken implementation: the lease might allow it or refuse with a different message
    expect(second.status).not.toBe(0);
    expect(second.stdout).toMatch(/APPLY_ALREADY_RUNNING/);
    // Refusal names the holder and suggests the remedies
    expect(second.stdout).toMatch(/spc apply owner/);
    // Clean up the hanging process
    child.kill("SIGKILL");
  });
});

describe("AO-006 CLI: owner inspection", () => {
  it("spc apply owner reports the three authorities distinctly", { timeout: 10000 }, () => {
    const r = sh(["apply", "owner"]);
    // With the implementation: this command exists and reports
    // lock occupancy, safety block state, and run metadata
    // With the broken implementation: the command doesn't exist
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
    // With the implementation: the flag is recognized but rejected
    // With the broken implementation: the flag is silently accepted
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/removed|migration|no longer/i);
  });
});

describe("AO-005 CLI: recover command", () => {
  it("spc apply recover exists and reports status even with no active block", { timeout: 10000 }, () => {
    const r = sh(["apply", "recover"]);
    // With the implementation: the command exists
    // With the broken implementation: unknown command
    expect(r.status).toBe(0);
  });
});
