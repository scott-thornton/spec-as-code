import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupPdf, makePdfRepo, spc, type PdfFixture } from "./research-pdf-fixture.js";

// Oracle for specs/research-pdf-dogfood.yaml RPDF-001/RPDF-004 (red,
// committed pre-run): the ordinary spc loop operates on a NON-CODE
// git repository end to end - init, spec validate, verify, plan
// (fake-provider scripted), apply (scripted executor fixing the
// manuscript AND regenerating the PDF), status - with no core
// changes and evidence inspectable through the existing surfaces.
// Today the fixture module does not exist - this is red.
let fx: PdfFixture;
let planFile = "";
beforeAll(() => {
  fx = makePdfRepo("loop");
});
afterAll(() => cleanupPdf(fx));

describe("RPDF-001: the loop runs on a non-code repository", () => {
  it("spc init functions on a bare non-code directory", () => {
    const bare = mkdtempSync(path.join(tmpdir(), "spc-rpdf-init-"));
    try {
      const r = spc({ root: bare, specFile: "" }, ["init"]);
      expect(r.status).toBe(0);
      expect(existsSync(path.join(bare, "specs"))).toBe(true);
      expect(existsSync(path.join(bare, ".spc", "config.yaml"))).toBe(true);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("spec validate accepts the fixture's manuscript spec", () => {
    const r = spc(fx, ["spec", "validate", "specs/paper.yaml"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/spec valid/i);
  });

  it("the baseline verify reports the source defect (RPF-001) while correspondence holds (RPF-002)", () => {
    const r = spc(fx, ["verify", "specs/paper.yaml"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/unsatisfied[^\n]*RPF-001|RPF-001[^\n]*unsatisfied/);
    expect(r.out).toMatch(/satisfied[^\n]*RPF-002|RPF-002[^\n]*satisfied/);
  }, 120_000);

  it("plan surfaces a persisted plan through the scripted provider", () => {
    const plansDir = path.join(fx.root, ".spc", "plans");
    mkdirSync(plansDir, { recursive: true }); // plan persists lazily
    const before = new Set(readdirSync(plansDir));
    const r = spc(fx, ["plan", "specs/paper.yaml"], 180_000);
    expect(r.status).toBe(0);
    const created = readdirSync(plansDir).filter((p) => !before.has(p));
    expect(created.length).toBeGreaterThanOrEqual(1);
    planFile = created[0]!;
    const plan = JSON.parse(readFileSync(path.join(plansDir, planFile), "utf8")) as { tasks: { id: string }[] };
    expect(plan.tasks[0]?.id).toBe("T001");
  }, 240_000);

  it("apply executes the scripted task - manuscript corrected, PDF regenerated, all three criteria satisfied", () => {
    const r = spc(fx, ["apply", path.join(".spc", "plans", planFile)], 240_000);
    expect(r.status).toBe(0);
    for (const id of ["RPF-001", "RPF-002", "RPF-003"]) {
      expect(r.out).toMatch(new RegExp(`satisfied[^\\n]*${id}|${id}[^\\n]*satisfied`));
    }
    // The non-code artifacts were actually changed and committed.
    expect(readFileSync(path.join(fx.root, "manuscript.md"), "utf8")).toContain("Result: 41");
    expect(readFileSync(path.join(fx.root, "paper.pdf"), "latin1")).toContain("Result: 41");
    const log = spawnSync("git", ["log", "--oneline"], { cwd: fx.root, encoding: "utf8" }).stdout;
    expect(log.split("\n").length).toBeGreaterThanOrEqual(3); // base + apply commits
  }, 300_000);
});

describe("RPDF-004: outcomes and provenance through the existing surfaces, no new artifact machinery", () => {
  it("the run record carries the evidence; status renders the effective chain verdict", () => {
    const runsDir = path.join(fx.root, ".spc", "runs");
    const runs = readdirSync(runsDir).filter((d) => d.startsWith("run-"));
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const evidence = readdirSync(runsDir)
      .map((d) => path.join(runsDir, d, "evidence.jsonl"))
      .filter(existsSync)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(evidence).toContain("RPF-001-A");
    expect(evidence).toContain("RPF-002-A");
    const status = spc(fx, ["status"]);
    expect(status.status).toBe(0);
    expect(status.out).toContain("paper");
  }, 120_000);

  it("the non-code repository needed nothing beyond its own files - no core artifacts leaked in", () => {
    const top = readdirSync(fx.root).sort();
    expect(top).toEqual([".git", ".gitignore", ".spc", "checks", "data", "manuscript.md", "paper.pdf", "references.json", "specs"]);
  });
});
