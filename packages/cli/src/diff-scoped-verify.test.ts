import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function commitTouch(rel: string): void {
  const file = path.join(root, rel);
  writeFileSync(file, (existsSync(file) ? readFileSync(file, "utf8") : "") + "t\n", "utf8");
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `touch ${rel}`]);
}

function runsCount(): number {
  const dir = path.join(root, ".spc", "runs");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

describe("DSV-001: derived-disjointness skipping", () => {
  it("a diff touching only pkg-a: file + unscoped evaluate, the pkg-b command skips with its scope named", { timeout: 60_000 }, () => {
    commitTouch("pkg-a/x.txt");
    const r = sh(["verify", "--scoped-to-diff", BASE, "specs/dsv.yaml"]);
    expect(r.status).toBe(0);
    // The partial banner with the honest counts (2 of 3, 1 skipped).
    expect(r.stdout).toMatch(/partial verification: 2 of 3 criteria evaluated, 1 skipped \(proven disjoint\)/i);
    // The skipped criterion is named with its reason and scope.
    expect(r.stdout).toMatch(/DSV-001-B/);
    expect(r.stdout).toMatch(/pkg-b/);
    expect(r.stdout).toMatch(/disjoint/i);
  });

  it("a diff touching the criterion's path AND the scoped package: nothing skips among the three", { timeout: 60_000 }, () => {
    commitTouch("pkg-b/touched.txt");
    commitTouch("pkg-a/x.txt");
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

describe("DSV-001 (adversarial F1): an uncomputable diff refuses, never a vacuous green", () => {
  it("a bogus base revision exits 2 with the git error surfaced - no empty-changed-set report", { timeout: 60_000 }, () => {
    const r = sh(["verify", "--scoped-to-diff", "0".repeat(40), "specs/dsv.yaml"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/--scoped-to-diff: cannot compute/i);
    expect(r.stdout).not.toMatch(/partial verification: 0 of 3/i);
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

// Rectification oracles (the backlog's live wire, 2026-11-11): verify's
// own skip engine carries the three false-disjoint channels impact's
// review found in the shared derivation - a SKIP is a criterion never
// executed, so an unproven skip is vacuous-green territory. The spec's
// banner letter is "proven disjoint"; these channels skip without
// proof. Today they are red.
interface FreshDsv {
  root: string;
  base: string;
  sh: (args: string[]) => { status: number; stdout: string };
  touch: (rel: string) => void;
  /** Touch the workspace yaml VALIDLY - appending a stray line would
   *  corrupt the workspace and fail pnpm for the wrong reason. */
  touchWorkspace: () => void;
}

function makeDsvRepo(): FreshDsv {
  const root = mkdtempSync(path.join(tmpdir(), "spc-dsv-ch-"));
  const git = (args: string[]): string => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  const write = (rel: string, content: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content, "utf8");
  };
  write("pnpm-workspace.yaml", "packages:\n  - pkg-a\n  - pkg-b\n");
  write("package.json", JSON.stringify({ name: "fixture-root", private: true }));
  write("pkg-a/package.json", JSON.stringify({ name: "pkg-a", version: "0.0.0", scripts: { nothing: "node ../ok.cjs" } }));
  write("pkg-b/package.json", JSON.stringify({ name: "pkg-b", version: "0.0.0", scripts: { nothing: "node ../ok.cjs" } }));
  write("ok.cjs", "process.exit(0);\n");
  // A TRACKED dist artifact: the filtered file set must not treat it as
  // outside a scope that contains it.
  write("pkg-b/dist/gen.js", "console.log(1);\n");
  write("specs/dsv.yaml",
    'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: dsv\n  title: DSV\ngoal: fixture\nrequirements:\n  - id: DSV-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: DSV-001-A\n        type: file\n        path: pkg-a/x.txt\n        assert:\n          exists: true\n      - id: DSV-001-B\n        type: command\n        command: pnpm --filter pkg-b run nothing\n        expect:\n          exitCode: 0\n      - id: DSV-001-C\n        type: command\n        command: node ok.cjs\n        expect:\n          exitCode: 0\n      - id: DSV-001-D\n        type: command\n        command: pnpm -r run nothing\n        expect:\n          exitCode: 0\n      - id: DSV-001-E\n        type: command\n        command: pnpm --filter pkg-b --filter ghost-pkg run nothing\n        expect:\n          exitCode: 0\n');
  write("pkg-a/x.txt", "x\n");
  write(".gitignore", ".spc/\n");
  git(["init", "-q", "-b", "main"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  return {
    root,
    base,
    sh: (args) => {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
      return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
    },
    touch: (rel) => {
      const file = path.join(root, rel);
      writeFileSync(file, (existsSync(file) ? readFileSync(file, "utf8") : "") + "t\n", "utf8");
      git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
      git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `touch ${rel}`]);
    },
    touchWorkspace: () => {
      writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - pkg-a\n  - pkg-b\n  - tools/*\n", "utf8");
      git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
      git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "touch workspace config"]);
    },
  };
}

function skippedIds(stdout: string): string[] {
  const parsed = JSON.parse(stdout) as { skippedCriteria?: { id: string }[] };
  return (parsed["skippedCriteria"] ?? []).map((s) => s.id);
}

describe("DSV-001 rectification: a skip must be PROVEN disjoint", () => {
  it("channel 1 - a changed TRACKED dist artifact inside the scope directory never skips that scope (the filtered file set is incomplete)", { timeout: 120_000 }, () => {
    const fx = makeDsvRepo();
    fx.touch("pkg-b/dist/gen.js");
    const r = fx.sh(["verify", "--scoped-to-diff", fx.base, "specs/dsv.yaml", "--format", "json"]);
    expect(r.status).toBe(0);
    const skipped = skippedIds(r.stdout);
    expect(skipped).not.toContain("DSV-001-B");
    expect(skipped).not.toContain("DSV-001-D");
    expect(skipped).toEqual(["DSV-001-A"]); // the untouched file path is the only PROVEN disjoint
  });

  it("channel 2 - a workspace-defining config change never skips a workspace-union scope (pnpm -r closures are DEFINED by those files)", { timeout: 120_000 }, () => {
    const fx = makeDsvRepo();
    fx.touchWorkspace();
    const r = fx.sh(["verify", "--scoped-to-diff", fx.base, "specs/dsv.yaml", "--format", "json"]);
    expect(r.status).toBe(0);
    const skipped = skippedIds(r.stdout);
    expect(skipped).not.toContain("DSV-001-D");
    expect(skipped).not.toContain("DSV-001-E"); // the ghost makes E's scope incomplete: never a skip
    expect(skipped).toEqual(["DSV-001-A", "DSV-001-B"]); // only the proven-disjoint package scopes skip
  });

  it("channel 3 - a declared package that does not resolve makes the scope incomplete: never a skip", { timeout: 120_000 }, () => {
    const fx = makeDsvRepo();
    fx.touch("pkg-a/x.txt");
    const r = fx.sh(["verify", "--scoped-to-diff", fx.base, "specs/dsv.yaml", "--format", "json"]);
    expect(r.status).toBe(0);
    const skipped = skippedIds(r.stdout);
    expect(skipped).not.toContain("DSV-001-E");
    expect(skipped).toEqual(["DSV-001-B"]); // pkg-b genuinely untouched and fully resolvable: the one proven skip
  });
});
