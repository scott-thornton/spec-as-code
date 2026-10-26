import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, git, gitOk } from "@spc/repo";
import type { Plan } from "@spc/schema";
import { applyPlan, mergeTaskPatch } from "./apply.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-parallel-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: two-features
  title: Two independent features
goal: Two independent modules exist and are tested.
requirements:
  - id: FEAT-A
    statement: Feature A works.
    priority: must
    acceptance:
      - id: FEAT-A-A
        type: file
        path: src/a.mjs
        assert:
          contains: "feature-a"
  - id: FEAT-B
    statement: Feature B works.
    priority: must
    acceptance:
      - id: FEAT-B-A
        type: file
        path: src/b.mjs
        assert:
          contains: "feature-b"
`;
const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;

const sharedSpecYaml = specYaml
  .replace("path: src/a.mjs", "path: src/shared.mjs")
  .replace("path: src/b.mjs", "path: src/shared.mjs");

function setupRepo(name: string, configExtra: string[], spec = specYaml): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), spec);
  writeFileSync(
    path.join(repo, ".spc", "config.yaml"),
    ["version: 1", "provider:", "  name: fake", "  script: .spc/fake-script.yaml", ...configExtra].join("\n"),
  );
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\n");
  commitAll(repo, "init");
  return repo;
}

function twoTaskPlan(): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-parallel", createdAt: "now" },
    spec: { id: "two-features", digest: ir.digest },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      { id: "T001", title: "Feature A", kind: "modify", intent: "create src/a.mjs", dependsOn: [], satisfies: ["FEAT-A"], targets: { write: ["src/a.mjs"] } },
      { id: "T002", title: "Feature B", kind: "modify", intent: "create src/b.mjs", dependsOn: [], satisfies: ["FEAT-B"], targets: { write: ["src/b.mjs"] } },
      { id: "T003", title: "Verify", kind: "verify", intent: "verify both", dependsOn: ["T001", "T002"], verifies: ["FEAT-A", "FEAT-B"] },
    ],
  };
}

describe("parallel execution (§78)", () => {
  it("executes disjoint writers concurrently and merges both patches deterministically", { timeout: 120_000 }, async () => {
    const repo = setupRepo("parallel", ["execution:", "  parallelism: 2"]);
    const provider = new FakeProvider(
      parseFakeScript(`
executor:
  T001:
    status: completed
    summary: feature a
    changes:
      - op: create
        path: src/a.mjs
        content: |
          export const a = "feature-a";
  T002:
    status: completed
    summary: feature b
    changes:
      - op: create
        path: src/b.mjs
        content: |
          export const b = "feature-b";
`),
    );
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-parallel"), JSON.stringify(twoTaskPlan(), null, 2));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider, log: () => {} });
    expect(report.status).toBe("succeeded");
    expect(report.requirements.find((r) => r.propertyId === "FEAT-A")?.status).toBe("satisfied");
    expect(report.requirements.find((r) => r.propertyId === "FEAT-B")?.status).toBe("satisfied");

    // Both patches merged into the integration branch.
    const a = gitOk(report.worktree!, ["show", "HEAD:src/a.mjs"]);
    const b = gitOk(report.worktree!, ["show", "HEAD:src/b.mjs"]);
    expect(a).toContain("feature-a");
    expect(b).toContain("feature-b");

    // Concurrency evidence: T002 started before T001 completed.
    const events = readFileSync(paths.eventsFile(report.runId), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; payload?: { taskId?: string } });
    // Concurrency evidence: T002 was launched before T001 finished.
    const idx = (type: string, taskId: string) =>
      events.findIndex((e) => e.type === type && e.payload?.taskId === taskId);
    expect(idx("TASK_STARTED", "T002")).toBeGreaterThan(-1);
    expect(idx("TASK_STARTED", "T002")).toBeLessThan(idx("TASK_COMPLETED", "T001"));
    const patches = events.filter((e) => e.type === "PATCH_MERGED");
    expect(patches).toHaveLength(2);
    // Task worktrees cleaned up.
    expect(readFileSync(paths.eventsFile(report.runId), "utf8")).toContain("PATCH_MERGED");
  }, 120_000);

  it("serializes overlapping writers via dependencies (cumulative, no clobber)", { timeout: 120_000 }, async () => {
    const repo = setupRepo("serialized", ["execution:", "  parallelism: 2"], sharedSpecYaml);
    const sharedIr = compileSpecSource(sharedSpecYaml, "specs/spec.yaml").ir!;
    const provider = new FakeProvider(
      parseFakeScript(`
executor:
  T001:
    status: completed
    summary: add feature a
    changes:
      - op: create
        path: src/shared.mjs
        content: |
          export const a = "feature-a";
  T002:
    status: completed
    summary: add feature b on top
    changes:
      - op: update
        path: src/shared.mjs
        content: |
          export const a = "feature-a";
          export const b = "feature-b";
`),
    );
    const plan = { ...twoTaskPlan(), spec: { id: "two-features", digest: sharedIr.digest } };
    plan.tasks[0] = { ...plan.tasks[0]!, targets: { write: ["src/shared.mjs"] } };
    plan.tasks[1] = { ...plan.tasks[1]!, title: "Feature B (same file)", dependsOn: ["T001"], targets: { write: ["src/shared.mjs"] } };
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-parallel"), JSON.stringify(plan, null, 2));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider, log: () => {} });
    expect(report.status).toBe("succeeded");
    const shared = gitOk(report.worktree!, ["show", "HEAD:src/shared.mjs"]);
    expect(shared).toContain("feature-a");
    expect(shared).toContain("feature-b");
  }, 120_000);

  it("mergeTaskPatch: conflicting patches are refused and the integration branch restored, never silently resolved", { timeout: 120_000 }, () => {
    const repo = path.join(root, "conflict-unit");
    mkdirSync(repo, { recursive: true });
    gitOk(repo, ["init", "-b", "main"]);
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "shared.mjs"), "base\n");
    commitAll(repo, "base");
    const base = gitOk(repo, ["rev-parse", "HEAD"]).trim();

    // Two branches from the same base rewriting the same lines differently.
    for (const [branch, content] of [
      ["task-a", "from A\n"],
      ["task-b", "from B\n"],
    ] as const) {
      gitOk(repo, ["checkout", "-b", branch, base]);
      writeFileSync(path.join(repo, "src", "shared.mjs"), content);
      commitAll(repo, branch);
    }
    const shaB = gitOk(repo, ["rev-parse", "task-b"]).trim();

    // Integration branch takes A's patch; B now conflicts.
    gitOk(repo, ["checkout", "-b", "integration", "task-a"]);
    const merged = mergeTaskPatch(repo, shaB);
    expect(merged.ok).toBe(false);
    // Integration restored to A's content - no partial merge state left behind.
    const content = readFileSync(path.join(repo, "src", "shared.mjs"), "utf8");
    expect(content).toBe("from A\n");
    const status = gitOk(repo, ["status", "--porcelain"]);
    expect(status.trim()).toBe("");

    // A non-conflicting patch still merges cleanly.
    gitOk(repo, ["checkout", "-b", "task-c", base]);
    writeFileSync(path.join(repo, "src", "other.mjs"), "other\n");
    commitAll(repo, "task-c");
    const shaC = gitOk(repo, ["rev-parse", "task-c"]).trim();
    gitOk(repo, ["checkout", "integration"]);
    expect(mergeTaskPatch(repo, shaC).ok).toBe(true);
  });
});

describe("parallel failure isolation", () => {
  it("a failed task's mutations never reach the integration branch", { timeout: 120_000 }, async () => {
    const repo = setupRepo("failed-merge", ["execution:", "  parallelism: 2"]);
    // T001 completes and writes src/a.mjs; T002 reports FAILED but has
    // already written src/b.mjs in its per-task worktree.
    const provider = new FakeProvider(
      parseFakeScript(`
executor:
  T001:
    status: completed
    summary: feature a
    changes:
      - op: create
        path: src/a.mjs
        content: |
          export const a = "feature-a";
  T002:
    status: failed
    summary: could not finish
    changes:
      - op: create
        path: src/b.mjs
        content: |
          export const b = "should-never-merge";
`),
    );
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-parallel"), JSON.stringify(twoTaskPlan(), null, 2));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider, log: () => {} });
    expect(report.status).toBe("failed");

    // T001's patch merged; T002's mutations are gone from the run branch.
    expect(gitOk(report.worktree!, ["show", "HEAD:src/a.mjs"])).toContain("feature-a");
    expect(git(report.worktree!, ["cat-file", "-e", "HEAD:src/b.mjs"]).ok).toBe(false);
    // T002's state records the failure, and no PATCH_MERGED exists for it.
    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    expect(events).toContain('"type":"TASK_FAILED"');
    const merged = events
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; payload?: { taskId?: string } })
      .filter((e) => e.type === "PATCH_MERGED");
    expect(merged.map((e) => e.payload?.taskId)).toEqual(["T001"]);
  }, 120_000);
});

describe("atomic model budget under parallelism", () => {
  it("a synchronously reserved budget admits exactly maxModelCalls tasks regardless of interleaving", { timeout: 120_000 }, async () => {
    const repo = setupRepo("budget", ["execution:", "  parallelism: 2", "  maxModelCalls: 1"]);
    const provider = new FakeProvider(
      parseFakeScript(`
executor:
  T001:
    status: completed
    summary: feature a
    changes:
      - op: create
        path: src/a.mjs
        content: |
          export const a = "feature-a";
  T002:
    status: completed
    summary: feature b
    changes:
      - op: create
        path: src/b.mjs
        content: |
          export const b = "feature-b";
`),
    );
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-parallel"), JSON.stringify(twoTaskPlan(), null, 2));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider, log: () => {} });
    // Exactly one task dispatched (budget 1); the other failed atomically.
    expect(report.modelCalls).toBe(1);
    const state = JSON.parse(readFileSync(paths.stateFile(report.runId), "utf8")) as {
      tasks: Record<string, { status: string; failure?: { code: string } }>;
    };
    const statuses = Object.values(state.tasks).map((t) => t.status);
    expect(statuses.filter((s) => s === "completed").length).toBe(1);
    const budgetFailed = Object.values(state.tasks).filter((t) => t.failure?.code === "MODEL_BUDGET_EXCEEDED");
    expect(budgetFailed).toHaveLength(1);
  }, 120_000);
});
