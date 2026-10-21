import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Plan } from "@spc/schema";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { git } from "@spc/repo";
import { applyPlan, spcPaths } from "./index.js";

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: cci
  title: Criterion chain
goal: fixture
requirements:
  - id: CC-001
    statement: Both markers exist.
    priority: must
    acceptance:
      - id: CC-001-A
        type: command
        command: node --test "tests/a.test.mjs"
        discriminating: true
      - id: CC-001-B
        type: command
        command: node --test "tests/b.test.mjs"
        discriminating: true
`;

let roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function setup(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "spc-cci-"));
  roots.push(repo);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(path.join(repo, "tests", "a.test.mjs"),
    ['import test from "node:test";', 'import assert from "node:assert/strict";', 'import { readFileSync, existsSync } from "node:fs";', 'test("a", () => { assert.ok(existsSync("../src/module.mjs") && readFileSync("../src/module.mjs","utf8").includes("alpha")); });', ""].join("\n"));
  writeFileSync(path.join(repo, "tests", "b.test.mjs"),
    ['import test from "node:test";', 'import assert from "node:assert/strict";', 'import { readFileSync, existsSync } from "node:fs";', 'test("b", () => { assert.ok(existsSync("../src/module2.mjs") && readFileSync("../src/module2.mjs","utf8").includes("beta")); });', ""].join("\n"));
  writeFileSync(path.join(repo, ".spc", "config.yaml"), "version: 1\nprovider:\n  name: fake\n  script: .spc/fake.yaml\nexecution:\n  inPlace: true\n  inPlaceBranch: current\nverification:\n  requireRedPhase: true\n");
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function fake(taskId: string, module: string, content: string): FakeProvider {
  const script = ["planner:", "  value: {}", "executor:", `  ${taskId}:`, "    status: completed", "    summary: work", "    changes:", "      - op: create", `        path: ${module}`, "        content: |", ...content.split("\n").map((l) => `          ${l}`), ""].join("\n");
  return new FakeProvider(parseFakeScript(script));
}

function planFor(id: string, digest: string, taskId: string, module: string, revision = "0000"): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1", kind: "Plan",
    metadata: { id, createdAt: "2026-10-21T00:00:00.000Z" },
    spec: { id: "cci", digest },
    repository: { revision, snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [{ id: taskId, title: "Work", kind: "modify", intent: "write", dependsOn: [], satisfies: ["CC-001"], targets: { write: [module] } }],
  } as never;
}

describe("criterion-level chain inheritance (the LIST-001 field case)", () => {
  it("a property whose criteria flip in DIFFERENT chain runs aggregates to satisfied in the chain head", async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });

    // Run 1: flip criterion A only (module alpha). B stays red.
    writeFileSync(paths.planFile("p1"), JSON.stringify(planFor("p1", ir.digest, "T001", "src/module.mjs"), null, 2));
    const run1 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T001", "src/module.mjs", 'export const alpha = "alpha";'), log: () => {} });
    expect(run1.status).toBe("partially_satisfied");
    expect(run1.requirements.find((r) => r.propertyId === "CC-001")?.status).toBe("unsatisfied");

    // Run 2 (child): A passes at base (flipped in run 1), B flips natively.
    writeFileSync(paths.planFile("p2"), JSON.stringify(planFor("p2", ir.digest, "T101", "src/module2.mjs", run1.resultRevision!), null, 2));
    const run2 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T101", "src/module2.mjs", 'export const beta = "beta";'), log: () => {} });

    // THE FIELD DEFECT: run 2 read CC-001 indeterminate because A
    // "passed at base" and property-level inheritance requires the WHOLE
    // property satisfied in an ancestor. Criterion-level inheritance:
    // every criterion has a flip somewhere in the digest-bound chain.
    expect(run2.status).toBe("succeeded");
    const cc = run2.requirements.find((r) => r.propertyId === "CC-001");
    expect(cc?.status).toBe("satisfied");
    expect(cc?.reason ?? "").toMatch(/prior run|chain/i);

    // Replay consistency: the satisfied verdict reconstructs from the log.
    const { replayRun } = await import("./index.js");
    const plan2 = JSON.parse(readFileSync(paths.planFile("p2"), "utf8"));
    const replay = replayRun(paths.runsDir, run2.runId, plan2);
    expect(replay.projectionMatches).toBe(true);
  });

  it("a criterion passing at base with NO ancestor flip stays indeterminate", async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    // Run 1 flips A only; run 2 does nothing (both A at base, B still red).
    writeFileSync(paths.planFile("p1"), JSON.stringify(planFor("p1", ir.digest, "T001", "src/module.mjs"), null, 2));
    const run1 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fake("T001", "src/module.mjs", 'export const alpha = "alpha";'), log: () => {} });
    // Run 2 with a no-op task on an out-of-the-way file.
    writeFileSync(paths.planFile("p2"), JSON.stringify(planFor("p2", ir.digest, "T101", "src/notes.md", run1.resultRevision!), null, 2));
    const run2 = await applyPlan({ repoRoot: repo }, {
      providerFactory: async () => new FakeProvider(parseFakeScript([
        "planner:", "  value: {}", "executor:", "  T101:", "    status: completed", "    summary: noop", "    changes:", "      - op: create", "        path: src/notes.md", '        content: "note"', "",
      ].join("\n"))),
      log: () => {},
    });
    expect(run2.status).not.toBe("succeeded");
    expect(run2.requirements.find((r) => r.propertyId === "CC-001")?.status).toBe("unsatisfied");
  });
});
