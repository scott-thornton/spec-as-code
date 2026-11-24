import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { workspacePackageDirs } from "@spc/repo";
import { referencedOracleDiff, runCounterfactualReplay } from "./oracle-replay.js";

// Oracle for specs/oracle-relative-paths.yaml (ORP-002, ORP-003, ORP-004).
// The criterion here is the shape this repository's criteria use - pnpm
// --filter <pkg> exec <tool> <file> - which none of the earlier replay
// fixtures exercised. At base its oracle path resolves to an absolute
// path, so the drift check answers held-fail-closed and the replay is
// unavailable. Whole-file run; no title filter.
const root = mkdtempSync(path.join(tmpdir(), "spc-orp-replay-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const T = { timeout: 180_000 };

function sh(cwd: string, cmd: string, args: string[]): { status: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function git(cwd: string, args: string[]): string {
  const r = sh(cwd, "git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.out}`);
  return r.out.trim();
}

/** The criterion under test: implementation broken at `base`, fixed at
 *  `result`; the oracle file (check.js) identical at both. */
const CMD = "pnpm --filter @fixture/pkg exec node check.js";
const ORACLE = 'if (require("./impl.js")() !== 0) process.exit(1);\n';

type Lockfile = "none" | "valid" | "broken";

function repo(name: string, lockfile: Lockfile): { dir: string; base: string; result: string } {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "packages", "pkg"), { recursive: true });
  writeFileSync(path.join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(path.join(dir, "packages", "pkg", "package.json"), '{"name":"@fixture/pkg","private":true}\n');
  writeFileSync(path.join(dir, "packages", "pkg", "impl.js"), "module.exports = () => 1; // broken\n");
  writeFileSync(path.join(dir, "packages", "pkg", "check.js"), ORACLE);
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  if (lockfile === "valid") {
    // A lockfile that matches the (dependency-free) workspace: the
    // frozen offline install in the replay worktree succeeds.
    const r = sh(dir, "pnpm", ["install", "--lockfile-only", "--offline"]);
    if (r.status !== 0) throw new Error(`lockfile-only failed: ${r.out}`);
  }
  if (lockfile === "broken") {
    // A lockfile that names no importer: the frozen install fails.
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), 'lockfileVersion: "9.0"\nimporters: {}\n');
  }
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(dir, "packages", "pkg", "impl.js"), "module.exports = () => 0; // fixed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "fix"]);
  const result = git(dir, ["rev-parse", "HEAD"]);
  return { dir, base, result };
}

describe("ORP-002: the drift check and the replay read a pnpm --filter oracle", () => {
  it("an oracle identical at both revisions is untouched, not held-fail-closed", T, async () => {
    const { dir, base, result } = repo("drift-untouched", "none");
    const drift = await referencedOracleDiff(dir, base, result, CMD, workspacePackageDirs(dir));
    expect(drift.status).toBe("untouched");
  });

  it("an oracle the run changed is drifted, named by its repository-relative path", T, async () => {
    const { dir, base } = repo("drift-changed", "none");
    writeFileSync(path.join(dir, "packages", "pkg", "check.js"), `${ORACLE}// edited by the run\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "oracle edit"]);
    const head = git(dir, ["rev-parse", "HEAD"]);
    const drift = await referencedOracleDiff(dir, base, head, CMD, workspacePackageDirs(dir));
    expect(drift.status).toBe("drifted");
    expect(drift.files).toEqual(["packages/pkg/check.js"]);
  });

  it("replay against the broken base answers red (dependency-free worktree)", T, async () => {
    const { dir, base, result } = repo("replay-none", "none");
    const r = await runCounterfactualReplay(dir, "orp", "ORP-A", CMD, base, result, workspacePackageDirs(dir));
    expect(r.outcome).toBe("red");
  });

  it("replay in a prepared worktree answers red", T, async () => {
    const { dir, base, result } = repo("replay-installed", "valid");
    const r = await runCounterfactualReplay(dir, "orp", "ORP-A", CMD, base, result, workspacePackageDirs(dir));
    expect(r.outcome).toBe("red");
  });

  it("a failed preparation is unavailable, never red", T, async () => {
    const { dir, base, result } = repo("replay-failed", "broken");
    const r = await runCounterfactualReplay(dir, "orp", "ORP-A", CMD, base, result, workspacePackageDirs(dir));
    expect(r.outcome).toBe("unavailable");
    expect(r.detail).toMatch(/prepar/i);
  });
});

describe("ORP-004: the chain gate is silent", () => {
  it("chain-memory.ts writes no console output", () => {
    const src = readFileSync(path.join(import.meta.dirname, "chain-memory.ts"), "utf8");
    expect(src).not.toMatch(/console\.log\(/);
  });
});
