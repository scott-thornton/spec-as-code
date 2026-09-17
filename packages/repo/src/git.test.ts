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
