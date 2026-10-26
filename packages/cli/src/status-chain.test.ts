import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Plan } from "@spc/schema";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { git } from "@spc/repo";
import { applyPlan, spcPaths } from "@spc/runtime";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: schain
  title: Status chain
goal: fixture
requirements:
  - id: SC-001
    statement: The module exports the marker.
    priority: must
    acceptance:
      - id: SC-001-A
        type: command
        command: node --test "tests/*.test.mjs"
        discriminating: true
`;

let roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function sh(cwd: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 60000 });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

function setup(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "spc-schain-"));
  roots.push(repo);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(path.join(repo, "tests", "s.test.mjs"),
    ['import test from "node:test";', 'import assert from "node:assert/strict";', 'import { marker } from "../src/module.mjs";', 'test("m", () => { assert.equal(marker(), "chain"); });', ""].join("\n"));
  writeFileSync(path.join(repo, ".spc", "config.yaml"), "version: 1\nprovider:\n  name: fake\n  script: .spc/fake.yaml\nexecution:\n  inPlace: true\n  inPlaceBranch: current\nverification:\n  requireRedPhase: true\n");
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function fake(taskId: string, create: boolean): FakeProvider {
  const script = ["planner:", "  value: {}", "executor:", `  ${taskId}:`, "    status: completed", "    summary: work", "    changes:", `      - op: ${create ? "create" : "update"}`, "        path: src/module.mjs", "        content: |", "          export function marker() {", '            return "chain";', "          }", ""].join("\n");
  return new FakeProvider(parseFakeScript(script));
}

function planFor(id: string, digest: string, taskId: string, revision = "0000"): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1", kind: "Plan",
    metadata: { id, createdAt: "2026-10-21T00:00:00.000Z" },
    spec: { id: "schain", digest },
    repository: { revision, snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [{ id: taskId, title: "Work", kind: "modify", intent: "write", dependsOn: [], satisfies: ["SC-001"], targets: { write: ["src/module.mjs"] } }],
  } as never;
}

describe("chain-aware surfaces", () => {
  it("status renders the effective chain with provenance and exit 0; --run shows the single run", { timeout: 120_000 }, async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("p1"), JSON.stringify(planFor("p1", ir.digest, "T001"), null, 2));
    const run1 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T001", true), log: () => {} });
    writeFileSync(paths.planFile("p2"), JSON.stringify(planFor("p2", ir.digest, "T101", run1.resultRevision!), null, 2));
    const run2 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T101", false), log: () => {} });
    expect(run2.status).toBe("succeeded");

    const status = sh(repo, ["status"]);
    expect(status.status).toBe(0);
    expect(status.stdout).toMatch(/effective chain status/i);
    expect(status.stdout).toMatch(/inherited/i);
    // Single-run view still available and honest.
    const single = sh(repo, ["status", "--run", run2.runId]);
    expect(single.stdout).toContain(run2.runId);
  });

  it("run pr leads with the chain verdict and separates it from the diff", { timeout: 120_000 }, async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("p1"), JSON.stringify(planFor("p1", ir.digest, "T001"), null, 2));
    const run1 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T001", true), log: () => {} });
    writeFileSync(paths.planFile("p2"), JSON.stringify(planFor("p2", ir.digest, "T101", run1.resultRevision!), null, 2));
    const run2 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T101", false), log: () => {} });
    const pr = sh(repo, ["run", "pr", run2.runId]);
    expect(pr.stdout).toMatch(/chain/i);
    expect(pr.stdout).toMatch(/2 linked runs|chain of 2/i);
  });

  it("brief shows chain depth for continued specs", { timeout: 120_000 }, async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("p1"), JSON.stringify(planFor("p1", ir.digest, "T001"), null, 2));
    const run1 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T001", true), log: () => {} });
    writeFileSync(paths.planFile("p2"), JSON.stringify(planFor("p2", ir.digest, "T101", run1.resultRevision!), null, 2));
    await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T101", false), log: () => {} });
    const brief = sh(repo, ["brief"]);
    expect(brief.stdout).toMatch(/\(chain\)|2 runs \(chain\)/);
  });
});
