import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listMatchingFiles } from "./observer.js";

// Oracle for specs/prompt-stability.yaml (PST-001): the excerpt lister
// behind every executor prompt returns deterministically sorted paths.
// Node readdir order is OS-dependent and unguaranteed - the same tree
// must compose the same prompt on every platform and at every moment,
// or every cache regime busts at once.
const root = mkdtempSync(path.join(tmpdir(), "spc-pst-repo-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Created in deliberately non-alphabetical order.
for (const p of ["lib/zeta.ts", "lib/alpha.ts", "lib/mid.ts", "lib/b2.ts", "lib/b10.ts"]) {
  mkdirSync(path.join(root, path.dirname(p)), { recursive: true });
  writeFileSync(path.join(root, p), "x\n", "utf8");
}

describe("listMatchingFiles sort contract (PST-001)", () => {
  it("returns matching files in deterministic sorted order regardless of creation order", () => {
    const listed = listMatchingFiles(root, ["lib/**"]);
    expect(listed).toEqual(["lib/alpha.ts", "lib/b10.ts", "lib/b2.ts", "lib/mid.ts", "lib/zeta.ts"]);
  });

  it("repeat calls are byte-stable", () => {
    const a = listMatchingFiles(root, ["lib/**"]);
    const b = listMatchingFiles(root, ["lib/**"]);
    expect(a).toEqual(b);
  });
});
