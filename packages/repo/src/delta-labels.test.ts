import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { contentDelta, contentSnapshot } from "./content.js";

let roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "spc-delta-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

describe("content delta labels", () => {
  it("classifies a first touch of a tracked file as modified, not created", () => {
    const root = repo();
    // Task start on a clean tree: the HEAD-diff snapshot is empty.
    const before = contentSnapshot(root);
    expect(before.entries.size).toBe(0);
    // The task modifies an existing tracked file and creates a new one.
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
    writeFileSync(path.join(root, "src", "new.ts"), "export const n = 1;\n", "utf8");
    const after = contentSnapshot(root);
    const delta = contentDelta(before, after, root);
    expect(delta.get("src/a.ts")).toBe("modified");
    expect(delta.get("src/new.ts")).toBe("created");
  });
});
