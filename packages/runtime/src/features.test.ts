import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { cancelRun } from "./cancel.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-features-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: bump-dep
  title: Dependency bump
goal: The dependency is upgraded safely.
requirements:
  - id: DEP-001
    statement: The dependency is upgraded and tests pass.
    priority: must
    acceptance:
      - id: DEP-001-A
        type: command
        command: node --test "tests/*.test.mjs"
`;

function setupRepo(name: string, configLines: string[]): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true});
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(
    path.join(repo, ".spc", "config.yaml"),
    ["version: 1", "provider:", "  name: fake", "  script: .spc/fake-script.yaml", ...configLines].join("\n"),
  );
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\n");
  writeFileSync(
    path.join(repo, "tests", "dep.test.mjs"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("dep", () => { assert.ok(true); });\n',
  );
  commitAll(repo, "init");
  return repo;
}

function planFor(repo: string, extraTask?: Record<string, unknown>) {
  const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
  const tasks: Record<string, unknown>[] = [
    { id: "T001", title: "Upgrade dependency", kind: "modify", intent: "bump", dependsOn: [], satisfies: ["DEP-001"], targets: { write: ["lib/dep.mjs"] } },
  ];
  if (extraTask) tasks.push(extraTask);
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-x", createdAt: "now" },
    spec: { id: "bump-dep", digest: ir.digest },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks,
  };
}

describe("§31 tiered amendment approval", () => {
  it("high-risk amendment (lockfile write) is gated behind a blocking follow-up; run ends blocked", async () => {
    const repo = setupRepo("tiered", ["execution:", "  amendmentApproval: tiered"]);
    const provider = new FakeProvider(
      parseFakeScript(`
executor:
  T001:
    status: needs_replan
    summary: need to touch the lockfile
    replanReason: lockfile must change
    observations:
      - type: dependency
        statement: The bump requires regenerating pnpm-lock.yaml.
        confidence: confirmed
        invalidates:
          taskIds: [T001]
replanner:
  T001:
    reason: lockfile rewrite required
    operations:
      - op: replaceTask
        taskId: T001
        task:
          id: T002
          title: Bump dependency and lockfile
          kind: modify
          intent: bump dep and lockfile
          dependsOn: []
          satisfies: [DEP-001]
          targets:
            write: [lib/dep.mjs, pnpm-lock.yaml]
  T002:
    status: completed
    summary: done
    changes:
      - op: create
        path: lib/dep.mjs
        content: |
          export const dep = "2.0.0";
`),
    );
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-x"), JSON.stringify(planFor(repo)));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider, log: () => {} });
    expect(report.status).toBe("blocked");
    const gate = report.followups.find((f) => f.type === "approval" && f.status === "open");
    expect(gate).toBeTruthy();
    expect(gate!.title).toContain("high-risk");
    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    expect(events).toContain("amendmentRisk");
    // The gated amendment is preserved for review.
    const dir = path.join(paths.runDir(report.runId), "amendments");
    expect(readdirSync(dir).some((f) => f.endsWith(".gated.json"))).toBe(true);
    // No worktree changes were applied from the gated amendment.
    expect(readFileSync(paths.eventsFile(report.runId), "utf8")).not.toContain('"type":"PATCH_MERGED"');
  }, 120_000);

  it("auto policy (default) still applies the same amendment without gating", async () => {
    const repo = setupRepo("auto", []);
    const provider = new FakeProvider(
      parseFakeScript(`
executor:
  T001:
    status: needs_replan
    summary: need lockfile
    replanReason: lockfile
    observations:
      - type: dependency
        statement: lockfile must change
        confidence: confirmed
        invalidates:
          taskIds: [T001]
replanner:
  T001:
    reason: lockfile
    operations:
      - op: replaceTask
        taskId: T001
        task:
          id: T002
          title: Bump and lock
          kind: modify
          intent: bump
          dependsOn: []
          satisfies: [DEP-001]
          targets:
            write: [lib/dep.mjs, pnpm-lock.yaml]
  T002:
    status: completed
    summary: done
    changes:
      - op: create
        path: lib/dep.mjs
        content: |
          export const dep = "2.0.0";
`),
    );
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-x"), JSON.stringify(planFor(repo)));
    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider, log: () => {} });
    expect(report.status).toBe("succeeded");
    expect(report.replans).toBe(1);
  }, 120_000);
});

describe("run cancellation", () => {
  it("marks an interrupted (running) run cancelled; resume then refuses", async () => {
    const repo = setupRepo("cancel", []);
    const paths = spcPaths(repo);
    const runId = "run-stale-1";
    mkdirSync(paths.runDir(runId), { recursive: true });
    writeFileSync(
      paths.metadataFile(runId),
      JSON.stringify({ runId, kind: "apply", specId: "bump-dep", specDigest: "d", createdAt: "now" }),
    );
    writeFileSync(
      paths.stateFile(runId),
      JSON.stringify({
        runId, kind: "apply", specId: "bump-dep", specDigest: "d", status: "running",
        createdAt: "now", updatedAt: "now", modelCalls: 0, replans: 0,
        tasks: { T001: { taskId: "T001", status: "running", attempt: 1 } },
        requirements: {},
      }),
    );
    const { EventStore } = await import("./events.js");
    const store = new EventStore(paths.eventsFile(runId), runId);
    store.append("RUN_CREATED", { specId: "bump-dep" });
    store.append("TASK_STARTED", { taskId: "T001", attempt: 1 });

    cancelRun(repo, runId);
    const state = JSON.parse(readFileSync(paths.stateFile(runId), "utf8")) as { status: string };
    expect(state.status).toBe("cancelled");
    const log = readFileSync(paths.eventsFile(runId), "utf8");
    expect(log).toContain('"type":"RUN_COMPLETED"');
    expect(log).toContain('"status":"cancelled"');

    // Cancelling a terminal run is refused (idempotent guard).
    expect(() => cancelRun(repo, runId)).toThrow(/already finished/);
  });
});
