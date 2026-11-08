import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Oracle for specs/criterion-challenge.yaml CHAL-004-A (red,
// committed pre-run): the inaugural archived fixture - the
// skew-carveout readonly-to-mutable type error (728f805 -> 3924025)
// challenged against SC-001-A in THIS repository, through the real
// CLI. Cold prepare in both worktrees (stale tsbuildinfo masked the
// original defect - without the cold build the challenge could
// repeat the false green). Today the fixture and command do not
// exist; this leg is red and HEAVY (two worktree pipelines).
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const REPO = path.resolve(import.meta.dirname, "../../..");

describe("CHAL-004: the archived skew-carveout challenge", () => {
  it("the committed fixture reconstructs the historical defect and the challenge detects it (discriminating)", () => {
    const r = spawnSync(process.execPath, [CLI, "challenge", "challenges/skew-carveout-readonly.yaml"], {
      cwd: REPO, encoding: "utf8", timeout: 590_000,
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    expect(r.status).toBe(0);
    expect(out).toMatch(/discriminating/i);
    // The detection is attributed: the TS2345 readonly diagnostic in
    // the mutated pipeline's captured output.
    expect(out).toMatch(/TS4104/);
    expect(out).toMatch(/readonly/i);
    // Provenance pinned in the report.
    expect(out).toMatch(/728f805|3924025/i);
  }, 600_000);
});
