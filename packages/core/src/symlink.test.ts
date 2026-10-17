import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "./spec/load.js";
import { isPhysicallyContained } from "./glob.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-symlink-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("physical containment (symlinks)", () => {
  it("isPhysicallyContained rejects symlink components, accepts real paths", () => {
    const wt = path.join(root, "wt");
    mkdirSync(path.join(wt, "allowed"), { recursive: true });
    mkdirSync(path.join(root, "outside"), { recursive: true });
    symlinkSync(path.join(root, "outside"), path.join(wt, "allowed", "link"));
    writeFileSync(path.join(root, "outside", "secret.txt"), "x");

    expect(isPhysicallyContained(wt, "allowed/real.txt")).toBe(true);
    expect(isPhysicallyContained(wt, "allowed/deep/new.txt")).toBe(true);
    // Lexically in scope; physically escapes the worktree.
    expect(isPhysicallyContained(wt, "allowed/link/secret.txt")).toBe(false);
    // The symlink itself as the write target also escapes.
    expect(isPhysicallyContained(wt, "allowed/link")).toBe(false);
  });

  it("spec compilation rejects file criteria with escaping paths (SPC1011)", () => {
    const bad = compileSpecSource(
      [
        "apiVersion: spc.dev/v1alpha1",
        "kind: Spec",
        "metadata:",
        "  id: bad",
        "  title: t",
        "goal: g",
        "requirements:",
        "  - id: R-001",
        "    statement: s",
        "    priority: must",
        "    acceptance:",
        "      - id: R-001-A",
        "        type: file",
        '        path: "../../etc/passwd"',
        "        assert:",
        "          exists: true",
      ].join("\n"),
      "specs/bad.yaml",
    );
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad.diagnostics)).toContain("SPC1011");

    const good = compileSpecSource(
      [
        "apiVersion: spc.dev/v1alpha1",
        "kind: Spec",
        "metadata:",
        "  id: good",
        "  title: t",
        "goal: g",
        "requirements:",
        "  - id: R-001",
        "    statement: s",
        "    priority: must",
        "    acceptance:",
        "      - id: R-001-A",
        "        type: file",
        "        path: src/a.ts",
        "        assert:",
        "          exists: true",
      ].join("\n"),
      "specs/good.yaml",
    );
    expect(good.ok).toBe(true);
  });
});
