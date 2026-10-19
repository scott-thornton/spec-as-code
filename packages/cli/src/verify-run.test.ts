import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-verifyrun-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: evidence-run
  title: Evidence run fixture
goal: fixture
requirements:
  - id: ER-001
    statement: The module exists with the marker.
    priority: must
    acceptance:
      - id: ER-001-A
        type: file
        path: src/mod.cjs
        assert:
          contains: "ok"
      - id: ER-001-B
        type: command
        command: test -f src/mod.cjs && grep -q ok src/mod.cjs
`;

function sh(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}

function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// Base commit: spec present, implementation absent.
mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc"), { recursive: true });
writeFileSync(path.join(root, "specs", "evidence-run.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "test@example.com"]);
git(["config", "user.name", "test"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

// Result revision: implementation lands on a side branch.
git(["checkout", "-q", "-b", "results"]);
mkdirSync(path.join(root, "src"), { recursive: true });
writeFileSync(path.join(root, "src", "mod.cjs"), "module.exports = 'ok';\n", "utf8");
git(["add", "."]);
git(["commit", "-q", "-m", "impl"]);
const resultRev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

// Current tree moves back to base: the implementation exists ONLY at the
// result revision - exactly the field situation (branch restored).
git(["checkout", "-q", "main"]);

// Fabricate the apply run's records: state carries the result revision.
const runDir = path.join(root, ".spc", "runs", "run-evidence");
mkdirSync(runDir, { recursive: true });
writeFileSync(
  path.join(runDir, "metadata.json"),
  JSON.stringify({ runId: "run-evidence", kind: "apply", specId: "evidence-run", specDigest: "sha256:" + "0".repeat(64), planId: "plan-x", baseRevision: "main", createdAt: "2026-10-19T00:00:00.000Z" }),
  "utf8",
);
writeFileSync(
  path.join(runDir, "state.json"),
  JSON.stringify({ runId: "run-evidence", kind: "apply", specId: "evidence-run", status: "succeeded", baseRevision: "main", resultRevision: resultRev }),
  "utf8",
);

describe("spc verify --run", () => {
  it("verifies the run's result revision in a temporary worktree, not the current tree", () => {
    const r = sh(["verify", "--run", "run-evidence"]);
    expect(r.stderr).toContain("ER-001");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(resultRev.slice(0, 8));
  });

  it("errors cleanly for an unknown run id", () => {
    const r = sh(["verify", "--run", "run-nope"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("run-nope");
  });

  it("errors cleanly when the run has no result revision", () => {
    const bareDir = path.join(root, ".spc", "runs", "run-bare");
    mkdirSync(bareDir, { recursive: true });
    writeFileSync(path.join(bareDir, "metadata.json"), JSON.stringify({ runId: "run-bare", kind: "verify", specId: "evidence-run", createdAt: "2026-10-19T00:00:00.000Z" }), "utf8");
    const r = sh(["verify", "--run", "run-bare"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/result/i);
  });
});
