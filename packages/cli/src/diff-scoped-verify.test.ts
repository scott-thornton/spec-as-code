import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/diff-scoped-verify.yaml (DSV-001..DSV-003, red,
// committed pre-run): partial verification by DERIVED disjointness -
// file criteria by exact path, command criteria by declared filter
// scope (never unscoped commands), the claim shrinks honestly
// (partial banner, never green-as-full), and the invocation leaves NO
// evidence footprint (no run record). Today the flag does not exist.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-dsv-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(args: string[], cwd = root): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

// Fixture: a pnpm workspace with two packages; the spec's criteria are
// satisfied when evaluated (file exists; commands exit 0).
mkdirSync(path.join(root, "pkg-a"), { recursive: true });
mkdirSync(path.join(root, "pkg-b"), { recursive: true });
writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - pkg-a\n  - pkg-b\n", "utf8");
writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-root", private: true }), "utf8");
writeFileSync(path.join(root, "pkg-a", "package.json"), JSON.stringify({ name: "pkg-a", version: "0.0.0", scripts: { nothing: "node ../ok.cjs" } }), "utf8");
writeFileSync(path.join(root, "pkg-b", "package.json"), JSON.stringify({ name: "pkg-b", version: "0.0.0", scripts: { nothing: "node ../ok.cjs" } }), "utf8");
writeFileSync(path.join(root, "ok.cjs"), "process.exit(0);\n", "utf8");
mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, "specs", "dsv.yaml"),
  'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: dsv\n  title: DSV\ngoal: fixture\nrequirements:\n  - id: DSV-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: DSV-001-A\n        type: file\n        path: pkg-a/x.txt\n        assert:\n          exists: true\n      - id: DSV-001-B\n        type: command\n        command: pnpm --filter pkg-b run nothing\n        expect:\n          exitCode: 0\n      - id: DSV-001-C\n        type: command\n        command: node ok.cjs\n        expect:\n          exitCode: 0\n',
  "utf8");
writeFileSync(path.join(root, "pkg-a", "x.txt"), "x\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
const BASE = git(["rev-parse", "HEAD"]).trim();

function commitTouch(pkg: string): void {
  writeFileSync(path.join(root, pkg, "touched.txt"), "t\n", "utf8");
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `touch ${pkg}`]);
}

function runsCount(): number {
  const dir = path.join(root, ".spc", "runs");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

describe("DSV-001: derived-disjointness skipping", () => {
  it("a diff touching only pkg-a: file + unscoped evaluate, the pkg-b command skips with its scope named", { timeout: 60_000 }, () => {
    commitTouch("pkg-a");
    const r = sh(["verify", "--scoped-to-diff", BASE, "specs/dsv.yaml"]);
    expect(r.status).toBe(0);
    // The partial banner with the honest counts (2 of 3, 1 skipped).
    expect(r.stdout).toMatch(/partial verification: 2 of 3 criteria evaluated, 1 skipped \(proven disjoint\)/i);
    // The skipped criterion is named with its reason and scope.
    expect(r.stdout).toMatch(/DSV-001-B/);
    expect(r.stdout).toMatch(/pkg-b/);
    expect(r.stdout).toMatch(/disjoint/i);
  });

  it("a diff touching pkg-b: nothing skips among the three", { timeout: 60_000 }, () => {
    commitTouch("pkg-b");
    const r = sh(["verify", "--scoped-to-diff", BASE, "specs/dsv.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/partial verification: 3 of 3 criteria evaluated, 0 skipped/i);
  });

  it("the json shape carries partial, counts, and skippedCriteria with reasons", { timeout: 60_000 }, () => {
    const r = sh(["verify", "--scoped-to-diff", BASE, "specs/dsv.yaml", "--format", "json"]);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed["partial"]).toBe(true);
    expect(parsed["evaluated"]).toBe(3);
    expect(parsed["skipped"]).toBe(0);
    expect(Array.isArray(parsed["skippedCriteria"])).toBe(true);
  });
});

describe("DSV-003: no evidence footprint", () => {
  it("a partial invocation creates no run record; a default verify creates one", { timeout: 120_000 }, () => {
    const before = runsCount();
    sh(["verify", "--scoped-to-diff", BASE, "specs/dsv.yaml"]);
    expect(runsCount()).toBe(before);
    sh(["verify", "specs/dsv.yaml"]);
    expect(runsCount()).toBe(before + 1);
  });
});
