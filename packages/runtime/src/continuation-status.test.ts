import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Plan } from "@spc/schema";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { git, gitOk } from "@spc/repo";
import { applyPlan, spcPaths } from "./index.js";

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: continuation
  title: Continuation
goal: fixture
requirements:
  - id: CT-001
    statement: The module exports continuation.
    priority: must
    acceptance:
      - id: CT-001-A
        type: command
        command: node --test "tests/*.test.mjs"
        discriminating: true
`;

let roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function setup(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "spc-continuation-"));
  roots.push(repo);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  writeFileSync(path.join(repo, ".spc", "config.yaml"), [
    "version: 1",
    "provider:",
    "  name: fake",
    "execution:",
    "  inPlace: true",
    "  inPlaceBranch: current",
    "verification:",
    "  requireRedPhase: true",
    "",
  ].join("\n"), "utf8");
  writeFileSync(
    path.join(repo, "tests", "continuation.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { marker } from "../src/module.mjs";',
      'test("marker", () => {',
      '  assert.equal(marker(), "continuation");',
      "});",
      "",
    ].join("\n"),
  );
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  gitOk(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function planFor(id: string, digest: string, taskId: string): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id, createdAt: "2026-10-20T00:00:00.000Z" },
    spec: { id: "continuation", digest },
    repository: { revision: "0000", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      {
        id: taskId,
        title: "Do the work",
        kind: "modify",
        intent: "write the module",
        dependsOn: [],
        satisfies: ["CT-001"],
        targets: { write: ["src/module.mjs"] },
      },
    ],
  };
}

describe("continuation runs inherit prior satisfied properties (the CHK3555 status artifact)", () => {
  it("a second run of the same spec reports prior-satisfied properties as satisfied, not indeterminate", { timeout: 120_000 }, async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });

    // Run 1: implements the module; the discriminating criterion flips.
    writeFileSync(paths.planFile("plan-one"), JSON.stringify(planFor("plan-one", ir.digest, "T001"), null, 2));
    const run1 = await applyPlan({ repoRoot: repo }, {
      providerFactory: async () => new FakeProvider(parseFakeScript(`
planner:
  value: {}
executor:
  T001:
    status: completed
    summary: wrote the module
    changes:
      - op: create
        path: src/module.mjs
        content: |
          export function marker() {
            return "continuation";
          }
`)),
      log: () => {},
    });
    expect(run1.status).toBe("succeeded");
    expect(run1.requirements.find((r) => r.propertyId === "CT-001")?.status).toBe("satisfied");

    // Run 2: a continuation (recovery/reconcile shape). The work is
    // already in the tree, so the discriminating criterion PASSES AT
    // BASE - the flip evaluator alone would record indeterminate
    // ("passed at base"), which is how CHK3555's PR draft came to say
    // 4/11 over work that was 10/10-must done.
    writeFileSync(paths.planFile("plan-two"), JSON.stringify(planFor("plan-two", ir.digest, "T101"), null, 2));
    const run2 = await applyPlan({ repoRoot: repo }, {
      providerFactory: async () => new FakeProvider(parseFakeScript(`
planner:
  value: {}
executor:
  T101:
    status: completed
    summary: no-op continuation task; work already landed
    changes: []
`)),
      log: () => {},
    });

    const ct = run2.requirements.find((r) => r.propertyId === "CT-001");
    expect(ct?.status).toBe("satisfied");
    expect(ct?.reason ?? "").toMatch(/prior (chain )?run/);
    expect(run2.status).toBe("succeeded");

    const state = JSON.parse(readFileSync(paths.stateFile(run2.runId), "utf8")) as {
      requirements: Record<string, { status: string; reason?: string }>;
    };
    expect(state.requirements["CT-001"]?.status).toBe("satisfied");
    expect(state.requirements["CT-001"]?.reason ?? "").toMatch(/prior (chain )?run/);
  });

  it("does not inherit when no prior run recorded the property satisfied", { timeout: 120_000 }, async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    // Single run whose task no-ops: criterion fails at base, no flip,
    // no prior satisfied record - must stay unsatisfied, not inherited.
    writeFileSync(paths.planFile("plan-one"), JSON.stringify(planFor("plan-one", ir.digest, "T001"), null, 2));
    const run = await applyPlan({ repoRoot: repo }, {
      providerFactory: async () => new FakeProvider(parseFakeScript(`
planner:
  value: {}
executor:
  T001:
    status: completed
    summary: no-op
    changes: []
`)),
      log: () => {},
    });
    const ct = run.requirements.find((r) => r.propertyId === "CT-001");
    expect(ct?.status).not.toBe("satisfied");
  });
});
