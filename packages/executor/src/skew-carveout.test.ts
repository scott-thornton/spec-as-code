import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateSubmission } from "./unmediated-guard.js";

// Oracle for specs/skew-carveout.yaml SC-001 (red, committed pre-run):
// the committed-bypass inspects WHAT moved. A baseline..HEAD delta
// confined to protected paths (author territory) does not fire the
// bypass; any non-protected path still refuses, named. Today the bypass
// refuses any HEAD movement at all - har's phase-18 false refusals.
const root = mkdtempSync(path.join(tmpdir(), "spc-skc-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const PROTECTED_PATTERN = "tests/**";

/** A fixture repo at a dispatch baseline, with task write targets on src/. */
function fixture(name: string): { root: string; baseline: string } {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(path.join(dir, "tests", "a.test.ts"), "test\n", "utf8");
  writeFileSync(path.join(dir, ".gitignore"), ".spc/\n", "utf8");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
  return { root: dir, baseline: git(dir, ["rev-parse", "HEAD"]).trim() };
}

const INPUT = (root: string, baseline: string) => ({
  worktreeRoot: root,
  baselineRevision: baseline,
  writeTargets: ["src/**"],
  proposedPaths: [],
  attribution: { writes: [] },
});

describe("SC-001: the committed bypass refuses what changed, not that anything changed", () => {
  it("a baseline..HEAD delta confined to protected paths does not fire the bypass (patterns threaded)", () => {
    const f = fixture("protected-only");
    // Author-side oracle amendment: a protected-path-only commit.
    writeFileSync(path.join(f.root, "tests", "a.test.ts"), "test amended\n", "utf8");
    git(f.root, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
    git(f.root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "oracle fix"]);
    const check = evaluateSubmission({ ...INPUT(f.root, f.baseline), protectedPatterns: [PROTECTED_PATTERN] });
    expect(check.decision).toBe("allow");
  });

  it("a non-protected commit still refuses, and the refusal names the offending path", () => {
    const f = fixture("src-moved");
    writeFileSync(path.join(f.root, "src", "a.ts"), "export const a = 2;\n", "utf8");
    git(f.root, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
    git(f.root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "task territory"]);
    const check = evaluateSubmission({ ...INPUT(f.root, f.baseline), protectedPatterns: [PROTECTED_PATTERN] });
    expect(check.decision).toBe("refuse");
    expect(check.code).toBe("UNMEDIATED_CHANGES");
    expect(check.message).toMatch(/src\/a\.ts/);
  });

  it("no patterns threaded: HEAD movement refuses regardless - the carve-out is explicit input, not ambient", () => {
    const f = fixture("ambient");
    writeFileSync(path.join(f.root, "tests", "a.test.ts"), "test amended\n", "utf8");
    git(f.root, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
    git(f.root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "oracle fix"]);
    const check = evaluateSubmission({ ...INPUT(f.root, f.baseline) });
    expect(check.decision).toBe("refuse");
    expect(check.code).toBe("UNMEDIATED_CHANGES");
  });

  it("a delta that cannot be computed refuses - fail closed, never silently allow (adversarial F-01 leg)", () => {
    const f = fixture("unresolvable");
    writeFileSync(path.join(f.root, "tests", "a.test.ts"), "test amended\n", "utf8");
    git(f.root, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
    git(f.root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "oracle fix"]);
    const bogus = "0".repeat(40);
    const check = evaluateSubmission({ ...INPUT(f.root, bogus), protectedPatterns: [PROTECTED_PATTERN] });
    expect(check.decision).toBe("refuse");
    expect(check.code).toBe("UNMEDIATED_CHANGES");
  });

  it("a rename into protected territory names BOTH sides - the task-territory deletion refuses (adversarial F-02 leg)", () => {
    const f = fixture("rename-launder");
    git(f.root, ["-c", "user.name=t", "-c", "user.email=t@t", "mv", "src/a.ts", "tests/moved.test.ts"]);
    git(f.root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "move"]);
    const check = evaluateSubmission({ ...INPUT(f.root, f.baseline), protectedPatterns: [PROTECTED_PATTERN] });
    expect(check.decision).toBe("refuse");
    expect(check.message).toMatch(/src\/a\.ts/);
  });

  it("HEAD unchanged: allow, as today (regression shape)", () => {
    const f = fixture("clean");
    const check = evaluateSubmission({ ...INPUT(f.root, f.baseline), protectedPatterns: [PROTECTED_PATTERN] });
    expect(check.decision).toBe("allow");
  });
});
