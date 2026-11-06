import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/patch-fresh-build.yaml PF-001 (red, committed
// pre-run): patch apply invalidates the incremental build state of
// every package it touches. Two shipped type errors hid behind stale
// .tsbuildinfo this session; the fixer's local build must be fresh
// after every apply. Today apply touches nothing but the patched
// files - the .tsbuildinfo survives and the oracle fails.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-pfb-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Fixture: two workspace-shaped packages; pkg-a is patched, pkg-b is
// not. Both carry planted .tsbuildinfo files.
mkdirSync(path.join(root, "pkg-a"), { recursive: true });
mkdirSync(path.join(root, "pkg-b"), { recursive: true });
writeFileSync(path.join(root, "pkg-a", "package.json"), JSON.stringify({ name: "pkg-a", version: "0.0.0" }), "utf8");
writeFileSync(path.join(root, "pkg-b", "package.json"), JSON.stringify({ name: "pkg-b", version: "0.0.0" }), "utf8");
writeFileSync(path.join(root, "pkg-a", "a.txt"), "alpha\n", "utf8");
writeFileSync(path.join(root, "pkg-a", "tsconfig.tsbuildinfo"), "STALE", "utf8");
writeFileSync(path.join(root, "pkg-b", "tsconfig.tsbuildinfo"), "STALE", "utf8");

// Compose + apply a single op against pkg-a via the real CLI.
const op = JSON.parse(
  spawnSync(process.execPath, [CLI, "patch", "build", "pkg-a/a.txt", "--anchor", "alpha", "--replacement", "ALPHA", "--root", root], { encoding: "utf8" }).stdout as string,
) as Record<string, unknown>;
const apply = spawnSync(process.execPath, [CLI, "patch", "apply", "/dev/stdin"], {
  input: JSON.stringify([op]),
  cwd: root,
  encoding: "utf8",
});
// The apply itself must succeed and patch the content.
expect(apply.status).toBe(0);

describe("PF-001: patch apply invalidates touched packages' build state", () => {
  it("the patched package's .tsbuildinfo is gone; the untouched package keeps its own", () => {
    // Content patched (the apply succeeded) - asserted above.
    expect(readFileSync(path.join(root, "pkg-a", "a.txt"), "utf8")).toBe("ALPHA\n");
    // The touched package's incremental state is invalidated.
    expect(existsSync(path.join(root, "pkg-a", "tsconfig.tsbuildinfo"))).toBe(false);
    // The untouched package is not swept.
    expect(existsSync(path.join(root, "pkg-b", "tsconfig.tsbuildinfo"))).toBe(true);
    // The apply reports the invalidation so the fixer knows the next
    // build is fresh.
    expect(apply.stdout).toMatch(/invalidated build caches? for 1 package/i);
  });
});
