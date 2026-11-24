import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { classifyCommandOracle, oracleSnapshotAt, workspacePackageDirs } from "./oracle-scope.js";

// Oracle for specs/oracle-relative-paths.yaml (ORP-001): a pnpm --filter
// criterion's oracle file is named by a repository-relative path, so git
// can read it at a revision. At base the package-directory resolver
// returns directories joined to an absolute root, so every such path is
// absolute and the snapshot fails closed. The shapes the earlier
// oracle-identity fixtures used (a bare node script, relative) are kept
// here as controls. Whole-file run; no title filter.
const root = mkdtempSync(path.join(tmpdir(), "spc-orp-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const VITEST_CMD = "pnpm --filter @fixture/pkg build > /dev/null && pnpm --filter @fixture/pkg exec vitest run src/x.test.ts";
const NODE_CMD = "pnpm --filter @fixture/pkg exec node src/check.js";
const ORACLE = 'import { it } from "vitest";\nit("x", () => {});\n';

function filesOf(c: ReturnType<typeof classifyCommandOracle>): string[] {
  return c.kind === "referenced" ? c.files : [];
}

let repoCount = 0;

/** A workspace whose oracle file is absent at `before` and present at `after`. */
function workspaceRepo(): { dir: string; before: string; after: string } {
  const dir = path.join(root, `ws-${++repoCount}`);
  mkdirSync(path.join(dir, "packages", "pkg", "src"), { recursive: true });
  writeFileSync(path.join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(path.join(dir, "packages", "pkg", "package.json"), '{"name":"@fixture/pkg","private":true}\n');
  writeFileSync(path.join(dir, "packages", "pkg", "src", "check.js"), "process.exit(0);\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  const before = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(dir, "packages", "pkg", "src", "x.test.ts"), ORACLE);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "oracle"]);
  const after = git(dir, ["rev-parse", "HEAD"]);
  return { dir, before, after };
}

describe("ORP-001: oracle files are repository-relative", () => {
  it("a pnpm --filter vitest criterion names its oracle by repository-relative path", () => {
    const { dir } = workspaceRepo();
    const c = classifyCommandOracle(VITEST_CMD, workspacePackageDirs(dir));
    expect(c.kind).toBe("referenced");
    expect(filesOf(c)).toEqual(["packages/pkg/src/x.test.ts"]);
  });

  it("the snapshot resolves at a revision where the oracle exists", () => {
    const { dir, after } = workspaceRepo();
    const snap = oracleSnapshotAt(dir, after, VITEST_CMD, workspacePackageDirs(dir));
    expect(snap).toBeDefined();
    expect(snap?.revision).toBe(after);
    expect(snap?.files.map((f) => f.path)).toEqual(["packages/pkg/src/x.test.ts"]);
    expect(snap?.files[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("the snapshot still fails closed where the oracle does not exist", () => {
    const { dir, before } = workspaceRepo();
    expect(oracleSnapshotAt(dir, before, VITEST_CMD, workspacePackageDirs(dir))).toBeUndefined();
  });

  it("a single-package repository resolves against its root", () => {
    const dir = path.join(root, "solo");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), '{"name":"@solo/root","private":true}\n');
    writeFileSync(path.join(dir, "src", "check.js"), "process.exit(0);\n");
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "base"]);
    const rev = git(dir, ["rev-parse", "HEAD"]);
    const cmd = "pnpm --filter @solo/root exec node src/check.js";
    expect(filesOf(classifyCommandOracle(cmd, workspacePackageDirs(dir)))).toEqual(["src/check.js"]);
    expect(oracleSnapshotAt(dir, rev, cmd, workspacePackageDirs(dir))).toBeDefined();
  });

  it("a package map carrying absolute directories still yields repository-relative oracle files", () => {
    const { dir, after } = workspaceRepo();
    // The shape the verifier's scope resolver hands out: root-joined directories.
    const absolute = new Map([["@fixture/pkg", path.join(dir, "packages", "pkg")]]);
    expect(oracleSnapshotAt(dir, after, NODE_CMD, absolute)).toBeDefined();
  });

  it("controls: a bare relative script is unchanged, and a package outside the root still fails closed", () => {
    const { dir, after } = workspaceRepo();
    const bare = "node packages/pkg/src/check.js";
    expect(filesOf(classifyCommandOracle(bare, workspacePackageDirs(dir)))).toEqual(["packages/pkg/src/check.js"]);
    expect(oracleSnapshotAt(dir, after, bare, workspacePackageDirs(dir))).toBeDefined();
    const outside = new Map([["@fixture/pkg", root]]);
    expect(oracleSnapshotAt(dir, after, NODE_CMD, outside)).toBeUndefined();
  });
});
