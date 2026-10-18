import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan, spcPaths } from "@spc/runtime";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-rectify-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Spec with one satisfiable and one unsatisfiable property.
const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: mixed
  title: Mixed outcomes
goal: One property holds, one does not.
requirements:
  - id: GOOD-001
    statement: The module exists.
    priority: must
    acceptance:
      - id: GOOD-001-A
        type: file
        path: src/mod.cjs
        assert:
          contains: "ok"
  - id: BAD-001
    statement: A missing feature exists.
    priority: must
    acceptance:
      - id: BAD-001-A
        type: file
        path: src/missing.cjs
        assert:
          exists: true
`;
const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;

const fakeScript = `
executor:
  T001:
    status: completed
    summary: wrote the module
    changes:
      - op: create
        path: src/mod.cjs
        content: |
          module.exports = "ok";
`;

import { spawnSync } from "node:child_process";
function spc(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function repoWithPartialRun(name: string): Promise<{ repo: string; runId: string }> {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(path.join(repo, ".spc", "config.yaml"), "version: 1\nprovider:\n  name: fake\n  script: .spc/fake-script.yaml\n");
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\n");
  commitAll(repo, "init");
  const paths = spcPaths(repo);
  mkdirSync(paths.plansDir, { recursive: true });
  writeFileSync(
    paths.planFile("plan-r"),
    JSON.stringify({
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-r", createdAt: "now" },
      spec: { id: "mixed", digest: ir.digest },
      repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [
        { id: "T001", title: "Write module", kind: "modify", intent: "create src/mod.cjs", dependsOn: [], satisfies: ["GOOD-001"], targets: { write: ["src/mod.cjs"] } },
        { id: "T002", title: "Verify both", kind: "verify", intent: "verify", dependsOn: ["T001"], verifies: ["GOOD-001", "BAD-001"] },
      ],
    }),
  );
  const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(fakeScript)), log: () => {} });
  expect(report.status).toBe("partially_satisfied");
  return { repo, runId: report.runId };
}

describe("spc rectify", () => {
  it("scaffolds from a run's unsatisfied properties, carrying facts and citing lineage", async () => {
    const { repo, runId } = await repoWithPartialRun("fromrun");
    const r = spc(repo, ["rectify", runId]);
    expect(r.status).toBe(0);
    const file = path.join(repo, "specs", "mixed-rectify.yaml");
    expect(existsSync(file)).toBe(true);
    const scaffold = readFileSync(file, "utf8");
    // The finding is carried as a fact with provenance.
    expect(scaffold).toContain("id: BAD-001-RECT");
    expect(scaffold).toContain("unsatisfied");
    expect(scaffold).toContain(`finding: "BAD-001"`);
    // The satisfied property is NOT scaffolded.
    expect(scaffold).not.toContain("GOOD-001-RECT");
    // Criteria are explicit TODOs for the human.
    expect(scaffold).toContain("TODO(author)");
    // And the scaffold deliberately fails validation until authored.
    const v = spc(repo, ["spec", "validate", "specs/mixed-rectify.yaml"]);
    expect(v.status).toBe(1);
    // The original spec still compiles - untouched regression gate.
    const orig = spc(repo, ["spec", "validate", "specs/spec.yaml"]);
    expect(orig.status).toBe(0);
    // The guidance printed points at the checklist loop.
    expect(r.stdout).toContain("spc spec validate");
    expect(r.stdout).toContain("regression gate");
  }, 120_000);

  it("scaffolds from an external findings file", async () => {
    const { repo } = await repoWithPartialRun("fromfile");
    const findingsFile = path.join(root, "findings.json");
    writeFileSync(
      findingsFile,
      JSON.stringify([
        { id: "PT-01", statement: "Payment rounding uses half-up; business rule is half-even.", severity: "blocker", class: "contract-gap", propertyRef: "PAY-001" },
        { id: "PT-02", statement: "No rate limit on the callback endpoint." },
      ]),
    );
    const r = spc(repo, ["rectify", "--findings", findingsFile]);
    expect(r.status).toBe(0);
    const file = path.join(repo, "specs", "mixed-rectify.yaml");
    const scaffold = readFileSync(file, "utf8");
    expect(scaffold).toContain("id: PT-01-RECT");
    expect(scaffold).toContain("half-even");
    expect(scaffold).toContain(`findingSeverity: "blocker"`);
    expect(scaffold).toContain(`relatedProperty: "PAY-001"`);
    expect(scaffold).toContain("id: PT-02-RECT");
  }, 120_000);

  it("refuses when there is nothing to rectify", async () => {
    const { repo, runId } = await repoWithPartialRun("nothing");
    // Rectify once (consumes the unsatisfied property into a scaffold)...
    spc(repo, ["rectify", runId]);
    // ...a findings file with zero findings is the cleaner refusal path.
    const empty = path.join(root, "empty.json");
    writeFileSync(empty, "[]");
    const r = spc(repo, ["rectify", "--findings", empty]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("FILE_INVALID");
  }, 120_000);

  it("refuses to overwrite an existing scaffold", async () => {
    const { repo, runId } = await repoWithPartialRun("twice");
    expect(spc(repo, ["rectify", runId]).status).toBe(0);
    const r = spc(repo, ["rectify", runId]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("SPEC_EXISTS");
  }, 120_000);
});
