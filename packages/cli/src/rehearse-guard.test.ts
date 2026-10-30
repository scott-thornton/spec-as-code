import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/rehearse-guard.yaml: the submit boundary makes
// rehearsal the path of least resistance. The guard fires only on the
// empirically observed hazard (multiple ops on one path) without a
// preflight VALID FOR THE SUBMITTED ANSWER (draft-digest identity - the
// record today binds nothing, rehearse-A-submit-B must read as
// unrehearsed); the bypass is escapable and still teaches; advice is
// shape-specific; candidate claims never see the guard; the rehearse
// and pipeline skills ship byte-identical in both copies.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const REPO = new URL("../../../", import.meta.url).pathname; // spec-plan root, for skill copies
const root = mkdtempSync(path.join(tmpdir(), "spc-rehearseguard-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "answered"), { recursive: true });
mkdirSync(path.join(root, "lib"), { recursive: true });
// agent dry-run resolves the repo's specs directory; without one it
// exits SPEC_FILE_NOT_FOUND before recording the preflight.
mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, "specs", "fixture.yaml"), 'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: fixture\n  title: F\ngoal: fixture\nrequirements:\n  - id: F-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: F-001-A\n        type: command\n        command: "true"\n', "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
writeFileSync(path.join(root, "lib", "real.txt"), "line one\nline two\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

const now = Date.now();
const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
function putPending(id: string, overrides: Record<string, unknown>): void {
  const base = { id, role: "executor", key: "x@1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: "p", createdAt: iso(-60_000) };
  writeFileSync(path.join(root, ".spc", "harness", "pending", `${id}.json`), JSON.stringify({ ...base, ...overrides }), "utf8");
}
putPending("executor-CHAIN@1-1", { expiresAt: iso(10 * 60_000) });
putPending("executor-REAL@1-1", { expiresAt: iso(10 * 60_000), prompt: `answer\n\n${JSON.stringify({ task: { id: "T001" }, repository: { revision: null } })}` });

const REAL_CONTENT = "line one\nline two\n";
const realDigest = "sha256:" + createHash("sha256").update(REAL_CONTENT, "utf8").digest("hex");
// A correctly-chained pair on one file: op2 binds the post-op1
// content, whatever op1's replacement was.
const chainedReal = (r1: string, r2: string) => [
  { op: "patch", path: "lib/real.txt", baseDigest: realDigest, anchor: "line one", replacement: r1 },
  { op: "patch", path: "lib/real.txt", baseDigest: "sha256:" + createHash("sha256").update(REAL_CONTENT.replace("line one", r1), "utf8").digest("hex"), anchor: "line two", replacement: r2 },
];
function writeAnswer(file: string, changes: unknown[]): void {
  writeFileSync(path.join(root, file), JSON.stringify({ status: "completed", summary: "s", changes, commands: [], observations: [], evidenceCandidates: [], followups: [] }), "utf8");
}
const chainedOps = (replacement: string) => [
  { op: "patch", path: "src/a.ts", baseDigest: "sha256:" + "1".repeat(64), anchor: "aaa", replacement },
  { op: "patch", path: "src/a.ts", baseDigest: "sha256:" + "2".repeat(64), anchor: "ccc", replacement: "ddd" },
];
writeAnswer("chain.json", chainedOps("bbb"));
writeAnswer("chain-modified.json", chainedOps("eee"));
writeAnswer("single.json", [{ op: "patch", path: "src/a.ts", baseDigest: "sha256:" + "1".repeat(64), anchor: "aaa", replacement: "bbb" }]);
writeAnswer("nochanges.json", []);
writeAnswer("real.json", chainedReal("line ONE", "line TWO"));
writeAnswer("real-modified.json", chainedReal("line CHANGED", "line TWO"));

describe("rehearse guard (CLI)", () => {
  it("refuses an unrehearsed chained-op answer; --no-preflight overrides and still teaches", () => {
    const refused = sh(["agent", "respond", "executor-CHAIN@1-1", "--file", "chain.json"]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/PREFLIGHT/);
    expect(refused.stdout).toMatch(/--no-preflight/);
    expect(refused.stdout).toMatch(/spc agent dry-run/);
    expect(refused.stdout).toMatch(/use-skill rehearse/);
    // Nothing was submitted: no answer record for the refusal.
    expect(sh(["agent", "respond", "executor-CHAIN@1-1", "--file", "chain.json"]).status).toBe(1);

    const bypass = sh(["agent", "respond", "executor-CHAIN@1-1", "--file", "chain.json", "--no-preflight"]);
    expect(bypass.status).toBe(0);
    expect(bypass.stdout).toMatch(/Answered executor-CHAIN@1-1/);
    // The bypass still prints the shape-specific advice (RG-002).
    expect(bypass.stdout).toMatch(/2 ops|2 change ops/);
  }, { timeout: 30_000 });

  it("a preflight counts only when its draft digest matches the submitted answer", { timeout: 120_000 }, () => {
    // Rehearse the real answer: dry-run stages it against the fixture
    // tree and records the preflight WITH the draft digest.
    const rehearsal = sh(["agent", "dry-run", "executor-REAL@1-1", "--file", "real.json"]);
    expect(rehearsalOk(rehearsal)).toBe(true);
    // Submitting the SAME answer passes without the bypass flag.
    const same = sh(["agent", "respond", "executor-REAL@1-1", "--file", "real.json"]);
    expect(same.status).toBe(0);
    expect(same.stdout).toMatch(/Answered executor-REAL@1-1/);
  });

  it("a rehearsed digest does NOT cover a modified answer (rehearse A, submit B)", { timeout: 120_000 }, () => {
    // executor-REAL@1-1 is now answered (consumed) - use a fresh twin.
    putPending("executor-TWIN@1-1", { expiresAt: iso(10 * 60_000), prompt: `answer\n\n${JSON.stringify({ task: { id: "T002" }, repository: { revision: null } })}` });
    // Rehearse one chained twin, submit a different one: digests differ
    // -> the rehearsed record does not cover this answer.
    writeAnswer("twin.json", chainedReal("line X", "line Y"));
    const rehearsal = sh(["agent", "dry-run", "executor-TWIN@1-1", "--file", "twin.json"]);
    expect(rehearsal.status).toBe(0);
    const twin = JSON.parse(readFileSync(path.join(root, "twin.json"), "utf8")) as { changes: unknown[] };
    writeFileSync(path.join(root, "twin-modified.json"), JSON.stringify({ ...twin, changes: chainedReal("line XX", "line YY") }), "utf8");
    const modified = sh(["agent", "respond", "executor-TWIN@1-1", "--file", "twin-modified.json"]);
    expect(modified.status).toBe(1);
    expect(modified.stdout).toMatch(/PREFLIGHT/);
  });

  it("single-op and op-less answers never trigger the guard", () => {
    putPending("executor-SINGLE@1-1", { expiresAt: iso(10 * 60_000) });
    putPending("executor-PLAIN@1-1", { expiresAt: iso(10 * 60_000) });
    const single = sh(["agent", "respond", "executor-SINGLE@1-1", "--file", "single.json"]);
    expect(single.status).toBe(0);
    expect(single.stdout).not.toMatch(/PREFLIGHT/);
    const plain = sh(["agent", "respond", "executor-PLAIN@1-1", "--file", "nochanges.json"]);
    expect(plain.status).toBe(0);
    expect(plain.stdout).not.toMatch(/PREFLIGHT/);
  });

  it("candidate claims never see the guard", () => {
    const claim = sh(["agent", "respond", "executor-CHAIN@1-1", "--from-candidate", "cand-nonexistent"]);
    expect(claim.status).toBe(1);
    expect(claim.stdout).toMatch(/CANDIDATE_NOT_FOUND/);
    expect(claim.stdout).not.toMatch(/PREFLIGHT/);
  });

  it("the rehearse and pipeline skills ship byte-identical in both copies with pinned content", () => {
    for (const name of ["rehearse", "pipeline"]) {
      const local = readFileSync(path.join(REPO, ".agents", "skills", name, "SKILL.md"));
      const bundled = readFileSync(path.join(REPO, "packages", "cli", "skills", name, "SKILL.md"));
      expect(local.equals(bundled)).toBe(true);
      const body = local.toString("utf8");
      if (name === "rehearse") {
        expect(body).toContain("irreversible thing goes last");
        expect(body).toContain("spc agent dry-run");
        expect(body).toContain("save-candidate");
      } else {
        expect(body).toContain("exit evidence is not done");
      }
    }
  });

  it("spc skills lists the new skills and use-skill prints them", () => {
    const list = sh(["skills"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/rehearse/);
    expect(list.stdout).toMatch(/pipeline/);
    const body = sh(["use-skill", "rehearse"]);
    expect(body.status).toBe(0);
    expect(body.stdout).toContain("irreversible thing goes last");
  });
});

function rehearsalOk(r: { status: number; stdout: string }): boolean {
  return r.status === 0 || /Staged:/.test(r.stdout);
}
