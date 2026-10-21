import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Plan } from "@spc/schema";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { git } from "@spc/repo";
import { applyPlan, spcPaths, resolveChain } from "./index.js";

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: chain
  title: Chain
goal: fixture
requirements:
  - id: CH-001
    statement: The module exports the marker.
    priority: must
    acceptance:
      - id: CH-001-A
        type: command
        command: node --test "tests/*.test.mjs"
        discriminating: true
`;

let roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function setup(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "spc-chain-"));
  roots.push(repo);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(path.join(repo, "tests", "chain.test.mjs"),
    ['import test from "node:test";', 'import assert from "node:assert/strict";', 'import { marker } from "../src/module.mjs";', 'test("marker", () => { assert.equal(marker(), "chain"); });', ""].join("\n"));
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
    spec: { id: "chain", digest },
    repository: { revision, snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [{ id: taskId, title: "Work", kind: "modify", intent: "write", dependsOn: [], satisfies: ["CH-001"], targets: { write: ["src/module.mjs"] } }],
  } as never;
}

describe("parentRunId lineage (approved ruling: validated ancestry at creation)", () => {
  it("run 2's parent defaults to run 1 when run 1's result is a git ancestor of run 2's base", async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });

    writeFileSync(paths.planFile("p1"), JSON.stringify(planFor("p1", ir.digest, "T001"), null, 2));
    const run1 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T001", true), log: () => {} });
    expect(run1.status).toBe("succeeded");

    writeFileSync(paths.planFile("p2"), JSON.stringify(planFor("p2", ir.digest, "T101", run1.resultRevision!), null, 2));
    const run2 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T101", false), log: () => {} });
    expect(run2.status).toBe("succeeded");

    const meta2 = JSON.parse(readFileSync(paths.metadataFile ? paths.metadataFile(run2.runId) : path.join(paths.runsDir, run2.runId, "metadata.json"), "utf8"));
    expect(meta2.parentRunId).toBe(run1.runId);

    // The chain resolves: run2 -> run1.
    const chain = resolveChain(paths.runsDir, run2.runId);
    expect(chain.map((r) => r.runId)).toEqual([run2.runId, run1.runId]);
  });

  it("two independent runs of the same spec never chain (chronology is not causality)", async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });

    // Run 1 on a side branch that is NEVER merged - run 2's base cannot
    // contain its result, so no lineage.
    git(repo, ["checkout", "-q", "-b", "side"]);
    writeFileSync(paths.planFile("p1"), JSON.stringify(planFor("p1", ir.digest, "T001"), null, 2));
    const run1 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T001", true), log: () => {} });
    expect(run1.status).toBe("succeeded");
    git(repo, ["checkout", "-q", "main"]);

    writeFileSync(paths.planFile("p2"), JSON.stringify(planFor("p2", ir.digest, "T101", git(repo, ["rev-parse", "HEAD"]).stdout.trim()), null, 2));
    const run2 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T101", true), log: () => {} });
    const meta2 = JSON.parse(readFileSync(path.join(paths.runsDir, run2.runId, "metadata.json"), "utf8"));
    expect(meta2.parentRunId ?? null).toBeNull();
    const chain = resolveChain(paths.runsDir, run2.runId);
    expect(chain.map((r) => r.runId)).toEqual([run2.runId]);
  });

  it("inheritance follows the chain: a run whose parent is unset inherits nothing", async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });

    // Run 1 succeeds on main.
    writeFileSync(paths.planFile("p1"), JSON.stringify(planFor("p1", ir.digest, "T001"), null, 2));
    const run1 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T001", true), log: () => {} });
    expect(run1.status).toBe("succeeded");

    // Run 2 on a fresh branch from the ORIGINAL init commit (before run 1's
    // result): not an ancestor, parent stays unset, no inheritance - the
    // property must be established by run 2's own flip.
    const init = git(repo, ["rev-list", "--max-parents=0", "HEAD"]).stdout.trim();
    git(repo, ["checkout", "-q", "-b", "fresh", init]);
    writeFileSync(paths.planFile("p2"), JSON.stringify(planFor("p2", ir.digest, "T101"), null, 2));
    const run2 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T101", true), log: () => {} });
    const meta2 = JSON.parse(readFileSync(path.join(paths.runsDir, run2.runId, "metadata.json"), "utf8"));
    expect(meta2.parentRunId ?? null).toBeNull();
    // No PROPERTY_INHERITED in run 2's events: it stood alone.
    const events = readFileSync(paths.eventsFile(run2.runId), "utf8");
    expect(events).not.toContain("PROPERTY_INHERITED");
  });
});
