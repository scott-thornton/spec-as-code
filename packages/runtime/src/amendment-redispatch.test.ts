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
  id: redispatch
  title: Redispatch
goal: fixture
requirements:
  - id: RD-001
    statement: The module exports redispatch.
    priority: must
    acceptance:
      - id: RD-001-A
        type: command
        command: node --test "tests/*.test.mjs"
`;

let roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function setup(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "spc-redispatch-"));
  roots.push(repo);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  mkdirSync(path.join(repo, "packages", "security"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(
    path.join(repo, "tests", "redispatch.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { marker } from "../packages/security/module.mjs";',
      'test("marker", () => {',
      '  assert.equal(marker(), "redispatch");',
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(repo, "packages", "security", "module.mjs"), 'export function marker() {\n  return "";\n}\n');
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  gitOk(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function script(): FakeProvider {
  return new FakeProvider(
    parseFakeScript(`
planner:
  value: {}
executor:
  T001:
    status: needs_replan
    summary: Target path in the plan is wrong; the module lives elsewhere.
    replanReason: module lives at packages/security/module.mjs
    observations:
      - type: architecture
        statement: The module lives at packages/security/module.mjs, not src/mod.mjs.
        confidence: confirmed
        invalidates:
          taskIds: [T001]
  T001@2:
    status: completed
    summary: Implemented at the corrected target.
    changes:
      - op: update
        path: packages/security/module.mjs
        content: |
          export function marker() {
            return "redispatch";
          }
replanner:
  T001:
    reason: planned target location was wrong
    operations:
      - op: changeTarget
        taskId: T001
        targets:
          write: [packages/security/module.mjs]
`),
  );
}

describe("amendment re-dispatch (the CHK3555 field defect)", () => {
  it("re-dispatches the triggering task after a changeTarget amendment that adds nothing", { timeout: 120_000 }, async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const plan: Plan = {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-redispatch", createdAt: "2026-10-20T00:00:00.000Z" },
      spec: { id: "redispatch", digest: ir.digest },
      repository: { revision: "0000", snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [
        {
          id: "T001",
          title: "Implement the marker",
          kind: "modify",
          intent: "modify src/mod.mjs",
          dependsOn: [],
          satisfies: ["RD-001"],
          targets: { write: ["src/mod.mjs"] },
        },
        {
          id: "T002",
          title: "Dependent task",
          kind: "verify",
          intent: "run acceptance",
          dependsOn: ["T001"],
          verifies: ["RD-001"],
        },
      ],
    };
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-redispatch"), JSON.stringify(plan, null, 2));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => script(), log: () => {} });

    // The field defect: CHK3555 run 1 concluded partially_satisfied with
    // the changeTarget-amended task parked in needs_replan and its
    // dependents blocked - the amendment path reset only ADDED tasks,
    // and a pure changeTarget amendment adds none.
    expect(report.status).toBe("succeeded");
    expect(report.replans).toBe(1);
    expect(report.requirements.find((r) => r.propertyId === "RD-001")?.status).toBe("satisfied");

    const events = readFileSync(paths.eventsFile(report.runId), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; payload?: Record<string, unknown> });
    const amended = events.find((e) => e.type === "PLAN_AMENDED");
    expect(amended?.payload?.addedTaskIds).toEqual([]);
    // T001 was started, parked in needs_replan, amended, then STARTED AGAIN.
    const starts = events.filter((e) => e.type === "TASK_STARTED" && e.payload?.taskId === "T001");
    expect(starts.length).toBeGreaterThanOrEqual(2);
    // The dependent ran instead of dying blocked behind a zombie.
    expect(events.some((e) => e.type === "TASK_COMPLETED" && e.payload?.taskId === "T002")).toBe(true);
    const state = JSON.parse(readFileSync(paths.stateFile(report.runId), "utf8")) as { tasks: Record<string, { status: string }> };
    expect(state.tasks.T001?.status).toBe("completed");
    expect(state.tasks.T002?.status).toBe("completed");
  });
});
