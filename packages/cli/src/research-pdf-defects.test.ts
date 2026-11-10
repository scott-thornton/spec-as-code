import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupPdf, evidenceOutput, makePdfRepo, spc, type PdfFixture } from "./research-pdf-fixture.js";


// Oracle for specs/research-pdf-dogfood.yaml RPDF-002 (red, committed
// pre-run): the two defect classes stay DISTINGUISHABLE. A
// source-content defect (wrong number in the manuscript, PDF faithful
// to it) violates the semantic criterion while correspondence passes;
// a stale-PDF defect (manuscript corrected, PDF unchanged) violates
// correspondence while every source assertion passes. Today the
// fixture module does not exist - this is red.
let a: PdfFixture;
let b: PdfFixture;
beforeAll(() => {
  a = makePdfRepo("faithful-defect");
  b = makePdfRepo("stale");
});
afterAll(() => {
  cleanupPdf(a);
  cleanupPdf(b);
});

describe("RPDF-002: source defects and stale artifacts stay distinguishable", () => {
  it("defect A (wrong number, faithful PDF): source RED, correspondence GREEN", () => {
    const r = spc(a, ["verify", "specs/paper.yaml"], 120_000);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/^\s{2}unsatisfied\s+RPF-001/m);
    expect(r.out).toMatch(/^\s{2}satisfied\s+RPF-002/m);
    expect(r.out).not.toMatch(/^\s{2}unsatisfied\s+RPF-002/m);
    expect(evidenceOutput(a)).toMatch(/manuscript says 42, data says 41/);
    expect(evidenceOutput(a)).toMatch(/pdf corresponds: 42/);
  }, 180_000);

  it("defect B (correct manuscript, stale PDF): source GREEN, correspondence RED", () => {
    const r = spc(b, ["verify", "specs/paper.yaml"], 120_000);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/^\s{2}satisfied\s+RPF-001/m);
    expect(r.out).not.toMatch(/^\s{2}unsatisfied\s+RPF-001/m);
    expect(r.out).toMatch(/^\s{2}unsatisfied\s+RPF-002/m);
    expect(evidenceOutput(b)).toMatch(/pdf reports 42, manuscript reports 41/);
    expect(evidenceOutput(b)).toMatch(/source consistent: 41/);
  }, 180_000);
});
