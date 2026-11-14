import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveScopeDirs, workspacePackageDirs } from "./command-cache.js";

// Oracle (red, committed pre-run): workspacePackageDirs starves on
// QUOTED globs - pnpm-workspace.yaml entries like `- "packages/*"`
// (this repository's own shape) keep their quotes in the minimal
// parser, so every @spc/* filter resolves to nothing and
// resolveScopeDirs returns empty scopes repo-wide. Found by the
// oracle-identity audit (review log run-mwgpvmrz). Today this is red.
const root = mkdtempSync(path.join(tmpdir(), "spc-wsglob-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeWorkspace(yamlContent: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "packages", "pkg-a"), { recursive: true });
  writeFileSync(path.join(dir, "pnpm-workspace.yaml"), yamlContent);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture-root", private: true }));
  writeFileSync(path.join(dir, "packages", "pkg-a", "package.json"), JSON.stringify({ name: "@fixture/pkg-a", private: true }));
  writeFileSync(path.join(dir, "packages", "pkg-a", "a.ts"), "export const a = 1;\n");
  return dir;
}

describe("workspacePackageDirs: quoted globs resolve like unquoted", () => {
  it("double-quoted globs (this repo's own shape) resolve every member", () => {
    const dir = makeWorkspace('packages:\n  - "packages/*"\n', "double-quoted");
    const m = workspacePackageDirs(dir);
    expect(m.get("@fixture/pkg-a")).toBeDefined();
  });

  it("single-quoted globs resolve too", () => {
    const dir = makeWorkspace("packages:\n  - 'packages/*'\n", "single-quoted");
    const m = workspacePackageDirs(dir);
    expect(m.get("@fixture/pkg-a")).toBeDefined();
  });

  it("unquoted globs (the only working shape today) keep working", () => {
    const dir = makeWorkspace(String.raw`packages:
  - packages/*
`, "unquoted");
    const m = workspacePackageDirs(dir);
    expect(m.get("@fixture/pkg-a")).toBeDefined();
  });

  it("quoted literal directories resolve (no glob)", () => {
    const dir = makeWorkspace('packages:\n  - "packages/pkg-a"\n', "literal-quoted");
    const m = workspacePackageDirs(dir);
    expect(m.get("@fixture/pkg-a")).toBeDefined();
  });

  it("resolveScopeDirs on a quoted-glob workspace returns the member dir (the starved consumer, end to end)", () => {
    const dir = makeWorkspace('packages:\n  - "packages/*"\n', "scoped");
    const dirs = resolveScopeDirs(dir, { packages: ["@fixture/pkg-a"], withDeps: false, recursive: false } as never);
    expect(dirs.length).toBe(1);
    expect(dirs[0]).toContain("pkg-a");
  });
});

void spawnSync; // keep the import shape stable for the executor
