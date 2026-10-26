import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { exportRun } from "./export.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-export-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: greet
  title: Greeting module
goal: A greet module exists.
requirements:
  - id: FEAT-A
    statement: The greet module exists and loads.
    priority: must
    acceptance:
      - id: FEAT-A-A
        type: command
        command: node -e "require('./src/greet.cjs')"
        discriminating: true
`;
const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;

const fakeScript = `
executor:
  T001:
    status: completed
    summary: wrote greet module
    changes:
      - op: create
        path: src/greet.cjs
        content: |
          module.exports = { greet: () => "hello" };
`;

function setupRepo(name: string, configLines: string[]): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/exports/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(
    path.join(repo, ".spc", "config.yaml"),
    ["version: 1", "provider:", "  name: fake", "  script: .spc/fake-script.yaml", ...configLines].join("\n"),
  );
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\n");
  commitAll(repo, "init");
  return repo;
}

function planFor(): unknown {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-export", createdAt: "now" },
    spec: { id: "greet", digest: ir.digest },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      { id: "T001", title: "Write greet", kind: "modify", intent: "create src/greet.cjs", dependsOn: [], satisfies: ["FEAT-A"], targets: { write: ["src/greet.cjs"] } },
    ],
  };
}

describe("spc run export", () => {
  it("emits a self-contained bundle with verifiable hashes", { timeout: 120_000 }, async () => {
    const repo = setupRepo("full", ["execution:", "  inPlace: true", "  inPlaceBranch: current"]);
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-export"), JSON.stringify(planFor()));
    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(fakeScript)), log: () => {} });
    expect(report.status).toBe("succeeded");

    const result = exportRun(repo, report.runId);
    expect(result.warnings).toEqual([]);

    // Manifest lists every component with a correct sha256.
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as {
      runId: string;
      specDigest: string;
      components: { path: string; sha256: string }[];
    };
    expect(manifest.runId).toBe(report.runId);
    expect(manifest.specDigest).toBe(ir.digest);
    expect(manifest.components.length).toBeGreaterThan(5);
    for (const c of manifest.components) {
      const file = path.join(result.dir, c.path);
      expect(existsSync(file)).toBe(true);
      const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
      expect(hash).toBe(c.sha256);
    }

    // The closure the run only referenced by digest is now inside.
    expect(existsSync(path.join(result.dir, "spec", "spec.yaml"))).toBe(true);
    expect(existsSync(path.join(result.dir, "plan", "plan-export.json"))).toBe(true);
    expect(existsSync(path.join(result.dir, "config.yaml"))).toBe(true);
    expect(existsSync(path.join(result.dir, "run", "events.jsonl"))).toBe(true);
    const patch = readFileSync(path.join(result.dir, "diff.patch"), "utf8");
    expect(patch).toContain("greet");
  }, 120_000);

  it("warns loudly when the spec changed since the run", { timeout: 120_000 }, async () => {
    const repo = setupRepo("drift", ["execution:", "  inPlace: true", "  inPlaceBranch: current"]);
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-export"), JSON.stringify(planFor()));
    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(fakeScript)), log: () => {} });
    expect(report.status).toBe("succeeded");

    // Edit the spec after the fact; digest no longer matches the run.
    writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml.replace("A greet module exists.", "A greet module exists. Amended."));
    const result = exportRun(repo, report.runId);
    expect(result.warnings.join(" ")).toContain("spec has changed since the run");
    expect(result.warnings.join(" ")).toContain(ir.digest);
  }, 120_000);

  it("refuses unknown runs", { timeout: 120_000 }, () => {
    const repo = setupRepo("empty", []);
    expect(() => exportRun(repo, "run-nope")).toThrow(/no run run-nope/);
  });
});
