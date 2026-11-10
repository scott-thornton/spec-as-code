import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupPdf, evidenceOutput, makePdfRepo, spc, type PdfFixture } from "./research-pdf-fixture.js";

// Oracle for specs/research-pdf-dogfood.yaml RPDF-003 + RPDF-C01
// (red, committed pre-run): the third, independent defect class - a
// fixture-defined VISIBLE layout defect (page footer missing from
// the rendered artifact) is rejected by the layout criterion while
// source and correspondence pass; and when the render check CANNOT
// determine the result deterministically (corrupt artifact bytes),
// the outcome is INCONCLUSIVE through the existing classification
// family (the check outlives the command budget -> budget-timeout) -
// never a fabricated visual failure. C01: the fixture is offline and
// deterministic - committed files, pure-fs scripts, nothing fetched.
// Today the fixture module does not exist - this is red.
let c: PdfFixture;
let d: PdfFixture;
beforeAll(() => {
  c = makePdfRepo("layout");
  d = makePdfRepo("corrupt");
});
afterAll(() => {
  cleanupPdf(c);
  cleanupPdf(d);
});

describe("RPDF-003: layout defects and undeterminable renders", () => {
  it("defect C (missing page footer): layout RED, source and correspondence GREEN", () => {
    const r = spc(c, ["verify", "specs/paper.yaml"], 120_000);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/^\s{2}unsatisfied\s+RPF-003/m);
    expect(r.out).toMatch(/^\s{2}satisfied\s+RPF-001/m);
    expect(r.out).toMatch(/^\s{2}satisfied\s+RPF-002/m);
    expect(r.out).not.toMatch(/^\s{2}unsatisfied\s+RPF-00[12]/m);
  }, 180_000);

  it("an undeterminable render is INDETERMINATE (budget-timeout), never a fabricated visual failure", () => {
    const r = spc(d, ["verify", "specs/paper.yaml"], 120_000);
    expect(r.out).toMatch(/^\s{2}indeterminate\s+RPF-003/m);
    expect(r.out).not.toMatch(/^\s{2}unsatisfied\s+RPF-003/m);
    // The asymmetry made visible: the corrupt bytes ALSO fabricate a red one
    // criterion over (correspondence-check exits 1 on undeterminable input)
    // - the principled refusal belongs to the layout check, not the kernel.
    expect(r.out).toMatch(/^\s{2}unsatisfied\s+RPF-002/m);
    expect(evidenceOutput(d)).toMatch(/undeterminable correspondence/);
    expect(evidenceOutput(d)).toMatch(/cannot determine|refusing to fabricate/i);
    // The other two criteria still resolved - the machine's failure to
    // see did not sink the whole sweep.
    expect(r.out).toMatch(/satisfied[^\n]*RPF-001|RPF-001[^\n]*satisfied/);
  }, 180_000);
});

describe("RPDF-C01: offline and deterministic in CI", () => {
  it("every fixture script and surface is committed, pure-fs, and fetches nothing", () => {
    for (const fixture of [c, d]) {
      // Clean tree: everything pinned to a git revision.
      const porcelain = spawnSync("git", ["status", "--porcelain"], { cwd: fixture.root, encoding: "utf8" }).stdout;
      expect(porcelain.trim()).toBe("");
      // The check scripts and config are pure filesystem - no network.
      for (const check of readdirSync(path.join(fixture.root, "checks"))) {
        const src = readFileSync(path.join(fixture.root, "checks", check), "utf8");
        expect(src).not.toMatch(/https?:|fetch\(|net\.connect|axios|node-fetch|node:http|node:dns|undici/);
      }
      const config = readFileSync(path.join(fixture.root, ".spc", "config.yaml"), "utf8");
      expect(config).not.toMatch(/https?:/);
      expect(config).toContain("name: fake");
    }
  });
});
