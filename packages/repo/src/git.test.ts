import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  commitAll,
  currentRevision,
  diffStat,
  findRepoRoot,
  gitOk,
  isGitRepo,
  statusDelta,
  statusPorcelain,
} from "./git.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-repo-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  gitOk(dir, ["init", "-b", "main"]);
}

describe("git adapter", () => {
  it("finds repo root by walking up", () => {
    initRepo(path.join(root, "walk"));
    const nested = path.join(root, "walk", "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "f.txt"), "x");
    expect(findRepoRoot(nested)).toBe(path.join(root, "walk"));
    expect(findRepoRoot(root)).toBeNull();
  });

  it("detects git repos, revisions and dirt", () => {
    const dir = path.join(root, "basic");
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    expect(isGitRepo(dir)).toBe(true);
    expect(statusPorcelain(dir).dirty).toBe(true);
    commitAll(dir, "init");
    expect(statusPorcelain(dir).dirty).toBe(false);
    const rev1 = currentRevision(dir);
    expect(rev1).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(path.join(dir, "a.txt"), "two\n");
    const delta = statusDelta(statusPorcelain(path.join(root, "basic")), statusPorcelain(dir));
    // sanity: dirty again
    expect(statusPorcelain(dir).dirty).toBe(true);
    commitAll(dir, "second");
    const rev2 = currentRevision(dir);
    expect(rev2).not.toBe(rev1);
    expect(diffStat(dir, rev1, rev2)).toContain("a.txt");
  });

  it("statusDelta classifies created/modified/deleted", () => {
    const dir = path.join(root, "delta");
    initRepo(dir);
    writeFileSync(path.join(dir, "keep.txt"), "k\n");
    writeFileSync(path.join(dir, "gone.txt"), "g\n");
    commitAll(dir, "init");
    const before = statusPorcelain(dir);
    writeFileSync(path.join(dir, "new.txt"), "n\n");
    writeFileSync(path.join(dir, "keep.txt"), "k2\n");
    gitOk(dir, ["rm", "-f", "gone.txt"]);
    const after = statusPorcelain(dir);
    const delta = statusDelta(before, after);
    expect(delta.get("new.txt")).toBe("created");
    expect(delta.get("keep.txt")).toBe("modified");
    expect(delta.get("gone.txt")).toBe("deleted");
  });
});

const IDENTITY_ENV_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
] as const;

describe("commit identity", () => {
  it("defers to the repository's configured git identity", () => {
    const dir = path.join(root, "configured");
    initRepo(dir);
    writeFileSync(path.join(dir, "f.txt"), "x\n");
    gitOk(dir, ["config", "user.name", "Test Author"]);
    gitOk(dir, ["config", "user.email", "author@example.com"]);

    const sha = commitAll(dir, "a change");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(gitOk(dir, ["log", "-1", "--format=%an"]).trim()).toBe("Test Author");
    expect(gitOk(dir, ["log", "-1", "--format=%ae"]).trim()).toBe("author@example.com");
    expect(gitOk(dir, ["log", "-1", "--format=%cn"]).trim()).toBe("Test Author");
  });

  it("falls back to the spc identity only when none can be resolved", () => {
    const dir = path.join(root, "fallback");
    initRepo(dir);
    writeFileSync(path.join(dir, "f.txt"), "x\n");
    // Forbid git's guess-from-hostname auto-detection so an unresolvable
    // identity is deterministic regardless of the ambient machine.
    gitOk(dir, ["config", "user.useConfigOnly", "true"]);

    const saved: Record<string, string | undefined> = {};
    const scrubbed: Record<string, string> = {
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    try {
      for (const key of IDENTITY_ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
      for (const [key, value] of Object.entries(scrubbed)) process.env[key] = value;

      const sha = commitAll(dir, "a change");
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(gitOk(dir, ["log", "-1", "--format=%an"]).trim()).toBe("spc");
      expect(gitOk(dir, ["log", "-1", "--format=%ae"]).trim()).toBe("spc@local");
    } finally {
      for (const key of IDENTITY_ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      for (const key of Object.keys(scrubbed)) delete process.env[key];
    }
  });
});
