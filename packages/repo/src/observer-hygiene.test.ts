import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileSpecSource } from "@spc/core";
import { git } from "./git.js";
import { observeRepository, readExcerpt } from "./observer.js";

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: hygiene-fixture
  title: Hygiene fixture
goal: fixture
requirements:
  - id: STRIP-001
    statement: remove the adid permission from the facebook android sdk manifest.
    priority: must
    acceptance:
      - id: STRIP-001-A
        type: command
        command: "true"
`;

let roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fixtureRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "spc-hygiene-"));
  roots.push(root);
  const mk = (p: string, content = "export const x = 1;\n"): void => {
    mkdirSync(path.join(root, path.dirname(p)), { recursive: true });
    writeFileSync(path.join(root, p), content, "utf8");
  };
  // Shallow source that should rank first for the "facebook" token.
  mk("src/facebook.ts");
  // Deep source with the same token: ranks below the shallow one.
  mk("a/b/c/d/e/facebook.ts");
  // Build-tool caches that must never be walked.
  for (const dir of [".gradle", "Pods", "DerivedData", ".dart_tool", ".expo", ".next", ".nuxt", ".turbo"]) {
    mk(`${dir}/facebook-cache.txt`);
  }
  // Binary artifact with the token in its name: walkable dir, but not a
  // source file - the matcher must not select it.
  mk("android/facebook.bin", "not text");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

describe("observer hygiene", () => {
  it("never walks mobile and build-tool cache directories", () => {
    const snapshot = observeRepository(fixtureRepo(), compileSpecSource(SPEC, "s.yaml").ir!);
    const all = JSON.stringify([...snapshot.directories.map((d) => d.path), ...snapshot.relevantArtifacts.map((a) => a.path)]);
    for (const dir of [".gradle", "Pods", "DerivedData", ".dart_tool", ".expo", ".next", ".nuxt", ".turbo"]) {
      expect(all).not.toContain(dir);
    }
  });

  it("ranks shallow source files above deep ones and never selects non-source artifacts", () => {
    const snapshot = observeRepository(fixtureRepo(), compileSpecSource(SPEC, "s.yaml").ir!);
    const paths = snapshot.relevantArtifacts.map((a) => a.path);
    expect(paths[0]).toBe("src/facebook.ts");
    expect(paths).not.toContain("android/facebook.bin");
    expect(paths.every((p) => /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|swift|rb|php|cs|c|cpp|h|hpp|sh|yaml|yml|json|toml|xml|md)$/.test(p))).toBe(true);
  });

  it("readExcerpt refuses binary content instead of returning NUL soup", () => {
    const root = mkdtempSync(path.join(tmpdir(), "spc-hygiene-bin-"));
    roots.push(root);
    const bin = path.join(root, "state.bin");
    writeFileSync(bin, Buffer.from([0x61, 0x00, 0x62, 0x00, 0x63, 0x00, 0x64, 0x00, 0x65]), "utf8");
    const text = path.join(root, "ok.ts");
    writeFileSync(text, "export const fine = true;\n", "utf8");
    expect(readExcerpt(root, "state.bin")).toBeNull();
    expect(readExcerpt(root, "ok.ts")).toContain("fine");
  });
});
