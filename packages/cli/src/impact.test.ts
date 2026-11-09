import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeImpactRepo, type ImpactFixture } from "./impact-fixture.js";

// Oracle for specs/evidence-impact-report.yaml IMP-001/IMP-003 (red,
// committed pre-run): spc impact <baseRev>..<headRev> resolves the
// changed tracked paths and the recorded evidence identities, and the
// report names per criterion the projection and its scope source, in
// text and --json. Fail-closed: an uncomputable range exits non-zero
// with the git error surfaced, never an empty report. Today the
// command does not exist - this is red.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
let fx: ImpactFixture;
beforeAll(() => {
  fx = makeImpactRepo();
});
afterAll(() => cleanup(fx));

function impact(args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, "impact", ...args], { cwd: fx.root, encoding: "utf8", timeout: 60_000 });
  return { status: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("IMP-001: the range resolves or refuses, fail-closed", () => {
  it("a computable range produces a report naming every criterion and the recorded evidence identity", () => {
    const r = impact([`${fx.base}..${fx.head}`]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("IMPD-001-A");
    expect(r.out).toContain("IMPD-001-B");
    expect(r.out).toContain("IMPD-001-C");
    expect(r.out).toContain("IMPD-001-D");
    // The recorded evidence identity from the run store is surfaced.
    expect(r.out).toContain("ev-demo-1");
    // The changed path is named (the report is about THIS range).
    expect(r.out).toContain("packages/pkg-a/src/a.ts");
  });

  it("an uncomputable range exits non-zero with the git error surfaced - never an empty report", () => {
    const r = impact(["nosuchrevision..HEAD"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/nosuchrevision|unknown revision|bad revision|ambiguous/i);
  });
});

describe("IMP-003: text and machine-readable json, with the scope source", () => {
  it("text: the untouched file criterion is scope-disjoint with its source (untouched path)", () => {
    const r = impact([`${fx.base}..${fx.head}`]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/IMPD-001-A[^\n]*scope-disjoint/);
    expect(r.out).toMatch(/IMPD-001-A[^\n]*untouched/i);
  });

  it("--json: parseable per-criterion entries carrying projection and source", () => {
    const r = impact([`${fx.base}..${fx.head}`, "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.out) as {
      specs: { id: string; criteria: { id: string; projection: string; source?: string; evidenceIds?: string[] }[] }[];
    };
    const spec = parsed.specs.find((s) => s.id === "impact-demo");
    expect(spec).toBeDefined();
    const a = spec!.criteria.find((c) => c.id === "IMPD-001-A");
    expect(a?.projection).toBe("scope-disjoint");
    expect(a?.evidenceIds).toContain("ev-demo-1");
  });
});
