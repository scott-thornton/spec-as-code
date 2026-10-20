import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-brief-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const SPEC_A = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: brief-a
  title: A
goal: fixture a
requirements:
  - id: BA-001
    statement: holds
    priority: must
    acceptance:
      - id: BA-001-A
        type: command
        command: "true"
`;
const SPEC_B = SPEC_A.replace("brief-a", "brief-b").replace("BA-001", "BB-001").replace("BA-", "BB-");

const CONFIG = `version: 1
provider:
  name: harness
verification:
  requireRedPhase: true
  protectedPaths: ["tests/**"]
`;

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
writeFileSync(path.join(root, "specs", "brief-a.yaml"), SPEC_A, "utf8");
writeFileSync(path.join(root, "specs", "brief-b.yaml"), SPEC_B, "utf8");
writeFileSync(path.join(root, ".spc", "config.yaml"), CONFIG, "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "test@example.com"]);
git(["config", "user.name", "test"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

// A run of brief-a whose recorded config digest NO LONGER matches (stale premise).
const runA = path.join(root, ".spc", "runs", "run-aaa");
mkdirSync(runA, { recursive: true });
writeFileSync(path.join(runA, "metadata.json"), JSON.stringify({ runId: "run-aaa", kind: "apply", specId: "brief-a", configDigest: "sha256:" + "0".repeat(64), createdAt: new Date().toISOString() }), "utf8");
writeFileSync(path.join(runA, "state.json"), JSON.stringify({ runId: "run-aaa", status: "succeeded", baseRevision: "x", resultRevision: "y" }), "utf8");
writeFileSync(path.join(runA, "followups.json"), JSON.stringify([{ id: "F-1", type: "investigation", blocking: true, status: "open", title: "look at this", description: "d", createdAt: new Date().toISOString() }]), "utf8");

// A run of brief-b whose recorded digest is CURRENT (no warning).
const actualDigest = "sha256:" + createHash("sha256").update(CONFIG, "utf8").digest("hex");
const runB = path.join(root, ".spc", "runs", "run-bbb");
mkdirSync(runB, { recursive: true });
writeFileSync(path.join(runB, "metadata.json"), JSON.stringify({ runId: "run-bbb", kind: "apply", specId: "brief-b", configDigest: actualDigest, createdAt: new Date().toISOString() }), "utf8");
writeFileSync(path.join(runB, "state.json"), JSON.stringify({ runId: "run-bbb", status: "partially_satisfied", baseRevision: "x", resultRevision: "y" }), "utf8");

// One pending harness request.
writeFileSync(
  path.join(root, ".spc", "harness", "pending", "planner-planner@1-1.json"),
  JSON.stringify({ id: "planner-planner@1-1", role: "planner", key: "planner@1", schemaName: "PlannerOutput", jsonSchema: { type: "object" }, system: "s", prompt: "p", createdAt: new Date().toISOString() }),
  "utf8",
);

// An unmerged run branch.
writeFileSync(path.join(root, "stray.txt"), "x\n", "utf8");
git(["checkout", "-q", "-b", "spc/legacy/run-zzz"]);
git(["add", "."]);
git(["commit", "-q", "-m", "stray"]);
git(["checkout", "-q", "main"]);
spawnSync("git", ["rm", "-q", "--cached", "stray.txt"], { cwd: root });
spawnSync("rm", [path.join(root, "stray.txt")]);

describe("spc brief", () => {
  it("renders every spec with its last run status and open blocking follow-ups", () => {
    const r = sh(["brief"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("brief-a");
    expect(r.stdout).toContain("succeeded");
    expect(r.stdout).toContain("brief-b");
    expect(r.stdout).toContain("partially");
    expect(r.stdout).toContain("F-1");
  });

  it("reports the pending harness queue and the config posture", () => {
    const r = sh(["brief"]);
    expect(r.stdout).toMatch(/pending harness requests: 1/i);
    expect(r.stdout).toContain("requireRedPhase");
    expect(r.stdout).toContain("tests/**");
  });

  it("warns when a spec's last run saw a different config, and stays silent when it matches", () => {
    const r = sh(["brief"]);
    expect(r.stdout).toMatch(/brief-a.*changed since|changed since.*brief-a|config changed since brief-a's last run/s);
    const lines = r.stdout.split("\n").filter((l) => /changed since/.test(l));
    expect(lines.some((l) => l.includes("brief-a"))).toBe(true);
    expect(lines.some((l) => l.includes("brief-b"))).toBe(false);
  });

  it("lists unmerged run branches", () => {
    const r = sh(["brief"]);
    expect(r.stdout).toContain("spc/legacy/run-zzz");
  });

  it("emits machine-readable json with the same facts", () => {
    const r = sh(["brief", "--format", "json"]);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    const a = j.specs.find((s: { id: string }) => s.id === "brief-a");
    const b = j.specs.find((s: { id: string }) => s.id === "brief-b");
    expect(a.lastRun.status).toBe("succeeded");
    expect(a.configChanged).toBe(true);
    expect(b.configChanged).toBe(false);
    expect(j.pendingHarness).toBe(1);
    expect(j.unmergedRunBranches).toContain("spc/legacy/run-zzz");
  });

  it("is read-only: no run records appear and the tree stays clean", () => {
    const before = readdirSync(path.join(root, ".spc", "runs")).sort().join(",");
    sh(["brief"]);
    const after = readdirSync(path.join(root, ".spc", "runs")).sort().join(",");
    expect(after).toBe(before);
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    expect(status.stdout.trim()).toBe("");
  });
});
