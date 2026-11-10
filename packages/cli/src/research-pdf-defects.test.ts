import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupPdf, evidenceOutput, makePdfRepo, spc, type PdfFixture } from "./research-pdf-fixture.js";

/** The criteria's own stdout rides the run's evidence payloads, not the verify table. */
function evidenceStdout(fixture: PdfFixture): string {
  const runsDir = path.join(fixture.root, ".spc", "runs");
  const out: string[] = [];
  for (const run of readdirSync(runsDir)) {
    const f = path.join(runsDir, run, "evidence.jsonl");
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
      const payload = (JSON.parse(line) as { payload?: Record<string, unknown> }).payload ?? {};
      if (typeof payload["stdout"] === "string") out.push(payload["stdout"]);
      if (typeof payload["stderr"] === "string") out.push(payload["stderr"]);
    }
  }
  return out.join("\n");
}

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
    expect(r.out).toMatch(/unsatisfied[^\n]*RPF-001|RPF-001[^\n]*unsatisfied/);
    expect(r.out).toMatch(/satisfied[^\n]*RPF-002|RPF-002[^\n]*satisfied/);
    expect(evidenceOutput(a)).toMatch(/manuscript says 42, data says 41/);
  }, 180_000);

  it("defect B (correct manuscript, stale PDF): source GREEN, correspondence RED", () => {
    const r = spc(b, ["verify", "specs/paper.yaml"], 120_000);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/satisfied[^\n]*RPF-001|RPF-001[^\n]*satisfied/);
    expect(r.out).toMatch(/unsatisfied[^\n]*RPF-002|RPF-002[^\n]*unsatisfied/);
    expect(evidenceOutput(b)).toMatch(/pdf reports 42, manuscript reports 41/);
  }, 180_000);
});
