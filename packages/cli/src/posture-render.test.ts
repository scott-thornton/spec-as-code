import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/spec-posture.yaml (PS-003): spc status renders one
// Posture line per spec without executing anything; spc brief
// summarizes posture counts. Read-only rendering; board and caching
// untouched.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-posturerender-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function gitsh(args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

const specA = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: pr-a
  title: a
goal: fixture
requirements:
  - id: PRA-001
    statement: Gate.
    priority: must
    acceptance:
      - id: PRA-001-A
        type: command
        command: node gate.cjs
        discriminating: true
`;
const specB = specA.replace("pr-a", "pr-b").replace("PRA-001", "PRB-001").replace("PRA-001-A", "PRB-001-A");

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc", "runs"), { recursive: true });
writeFileSync(path.join(root, "specs", "pr-a.yaml"), specA, "utf8");
writeFileSync(path.join(root, "specs", "pr-b.yaml"), specB, "utf8");
writeFileSync(path.join(root, "gate.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "t@t"]);
gitsh(["config", "user.name", "t"]);
writeFileSync(path.join(root, ".keep"), "", "utf8");
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);

function digestOfSpec(file: string): string {
  const out = sh(["spec", "validate", file]).stdout;
  return /Digest: (sha256:\w+)/.exec(out)?.[1] ?? `sha256:${"0".repeat(64)}`;
}
const digestA = digestOfSpec("specs/pr-a.yaml");
const digestB = digestOfSpec("specs/pr-b.yaml");
const head = gitsh(["rev-parse", "HEAD"]);

function greenRun(runId: string, specId: string, digest: string, prop: string): void {
  const dir = path.join(root, ".spc", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({ runId, kind: "verify", specId, specDigest: digest, baseRevision: head, createdAt: "2026-10-26T00:00:00.000Z" }),
    "utf8",
  );
  writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ type: "RUN_CREATED", payload: { dirty: false } }) + "\n", "utf8");
  writeFileSync(path.join(dir, "evidence.jsonl"), "", "utf8");
  writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({ status: "succeeded", tasks: {}, requirements: { [prop]: { propertyId: prop, status: "satisfied" } } }),
    "utf8",
  );
}

// pr-a: standing (green + fresh). pr-b: unverified (no runs).
greenRun("v-pra", "pr-a", digestA, "PRA-001");

describe("posture rendering (PS-003)", () => {
  it("spc status renders a Posture line per spec without creating runs", () => {
    const before = require("node:fs").readdirSync(path.join(root, ".spc", "runs")).length;
    const r = sh(["status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Posture:\s*standing.*pr-a|pr-a[\s\S]*?Posture:\s*standing/);
    expect(r.stdout).toMatch(/Posture:\s*unverified[\s\S]*?pr-b|pr-b[\s\S]*?Posture:\s*unverified/);
    const after = require("node:fs").readdirSync(path.join(root, ".spc", "runs")).length;
    expect(after).toBe(before); // read-only: no runs created
  });

  it("spc brief summarizes posture counts", () => {
    const r = sh(["brief"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/posture/i);
    expect(r.stdout).toMatch(/1 standing/);
    expect(r.stdout).toMatch(/1 unverified/);
  });
});
