import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-cpt-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: two-files
  title: Two file features
goal: Two independent files exist.
requirements:
  - id: FEAT-A
    statement: File A exists with marker a.
    priority: must
    acceptance:
      - id: FEAT-A-A
        type: file
        path: src/a.mjs
        assert:
          contains: "marker-a"
  - id: FEAT-B
    statement: File B exists with marker b.
    priority: must
    acceptance:
      - id: FEAT-B-A
        type: file
        path: src/b.mjs
        assert:
          contains: "marker-b"
`;
const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;

function setupRepo(name: string, configLines: string[]): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n");
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
    metadata: { id: "plan-cpt", createdAt: "now" },
    spec: { id: "two-files", digest: ir.digest },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      { id: "T001", title: "Write A", kind: "modify", intent: "create src/a.mjs", dependsOn: [], satisfies: ["FEAT-A"], targets: { write: ["src/a.mjs"] } },
      { id: "T002", title: "Write B", kind: "modify", intent: "create src/b.mjs", dependsOn: [], satisfies: ["FEAT-B"], targets: { write: ["src/b.mjs"] } },
      { id: "T003", title: "Verify", kind: "verify", intent: "verify both", dependsOn: ["T001", "T002"], verifies: ["FEAT-A", "FEAT-B"] },
    ],
  };
}

const fakeScript = `
executor:
  T001:
    status: completed
    summary: wrote A
    changes:
      - op: create
        path: src/a.mjs
        content: |
          export const a = "marker-a";
  T002:
    status: completed
    summary: wrote B
    changes:
      - op: create
        path: src/b.mjs
        content: |
          export const b = "marker-b";
`;

function provider(): FakeProvider {
  return new FakeProvider(parseFakeScript(fakeScript));
}

describe("commit-per-task", () => {
  it("enabled: each task lands as its own revision on the run branch, recorded on task state", async () => {
    const repo = setupRepo("on", ["execution:", "  commitPerTask: true"]);
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-cpt"), JSON.stringify(planFor()));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider(), log: () => {} });
    expect(report.status).toBe("succeeded");

    // Branch history: one commit per modify task (plus nothing else needed a commit).
    const log = gitOk(report.worktree!, ["log", `--format=%s`, `${report.baseRevision}..HEAD`]);
    const subjects = log.trim().split("\n").filter((s) => s.trim() !== "");
    const taskCommits = subjects.filter((s) => s.startsWith("spc: task T"));
    expect(taskCommits).toHaveLength(2);
    // git log lists newest first; assert membership, not order.
    expect(taskCommits.join("\n")).toContain("task T001");
    expect(taskCommits.join("\n")).toContain("task T002");

    // Task states carry their revisions.
    const state = JSON.parse(readFileSync(paths.stateFile(report.runId), "utf8")) as {
      tasks: Record<string, { revision?: string }>;
    };
    expect(state.tasks["T001"]?.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(state.tasks["T002"]?.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(state.tasks["T003"]?.revision).toBeUndefined();

    // Events record the commits.
    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    expect((events.match(/"type":"TASK_COMMITTED"/g) ?? []).length).toBe(2);

    // Run-level diff still covers the whole transition.
    expect(report.changedFileCount).toBe(2);
  }, 120_000);

  it("disabled (default): single result revision, no TASK_COMMITTED events, no per-task revisions", async () => {
    const repo = setupRepo("off", []);
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-cpt"), JSON.stringify(planFor()));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider(), log: () => {} });
    expect(report.status).toBe("succeeded");

    const log = gitOk(report.worktree!, ["log", "--format=%s", `${report.baseRevision}..HEAD`]);
    const subjects = log.trim().split("\n").filter((s) => s.trim() !== "");
    expect(subjects.filter((s) => s.startsWith("spc: task T"))).toHaveLength(0);
    expect(subjects.length).toBe(1); // the single run-result commit

    const state = JSON.parse(readFileSync(paths.stateFile(report.runId), "utf8")) as {
      tasks: Record<string, { revision?: string }>;
    };
    expect(state.tasks["T001"]?.revision).toBeUndefined();
    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    expect(events).not.toContain('"type":"TASK_COMMITTED"');
    expect(report.changedFileCount).toBe(2);
  }, 120_000);
});
