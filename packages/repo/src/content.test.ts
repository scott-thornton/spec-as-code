import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitAll, gitOk } from "./git.js";
import { contentDelta, contentSnapshot } from "./content.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-content-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("content-based task delta", () => {
  it("the dirty-file exploit: an out-of-scope rewrite of an already-dirty file IS caught", () => {
    const repo = path.join(root, "exploit");
    mkdirSync(repo, { recursive: true });
    gitOk(repo, ["init", "-b", "main"]);
    writeFileSync(path.join(repo, "src-shared.ts"), "original\n");
    commitAll(repo, "init");

    // Task A leaves the file dirty (" M").
    writeFileSync(path.join(repo, "src-shared.ts"), "task-a edit\n");
    const before = contentSnapshot(repo);

    // Task B rewrites it further; git STATUS stays " M" - the
    // transition-based delta reported nothing. Content identity moves.
    writeFileSync(path.join(repo, "src-shared.ts"), "task-b SNEAKY edit\n");
    const after = contentSnapshot(repo);

    const delta = contentDelta(before, after);
    expect(delta.get("src-shared.ts")).toBe("modified");

    // And a genuinely untouched dirty file produces no delta.
    const still = contentSnapshot(repo);
    expect(contentDelta(after, still).size).toBe(0);
  });

  it("created, deleted and untracked changes are classified by content", () => {
    const repo = path.join(root, "kinds");
    mkdirSync(repo, { recursive: true });
    gitOk(repo, ["init", "-b", "main"]);
    writeFileSync(path.join(repo, "tracked.txt"), "v1\n");
    commitAll(repo, "init");
    const before = contentSnapshot(repo);

    writeFileSync(path.join(repo, "new.txt"), "n\n"); // untracked created
    writeFileSync(path.join(repo, "tracked.txt"), "v2\n"); // modified
    rmSync(path.join(repo, "tracked.txt")); // ... then delete it instead
    const after = contentSnapshot(repo);

    const delta = contentDelta(before, after);
    expect(delta.get("new.txt")).toBe("created");
    expect(delta.get("tracked.txt")).toBe("deleted");
  });
});
