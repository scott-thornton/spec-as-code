import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-inplace-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: one-file
  title: One file feature
goal: A file with a marker exists.
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
    metadata: { id: "plan-inplace", createdAt: "now" },
    spec: { id: "one-file", digest: ir.digest },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      { id: "T001", title: "Write A", kind: "modify", intent: "create src/a.mjs", dependsOn: [], satisfies: ["FEAT-A"], targets: { write: ["src/a.mjs"] } },
      { id: "T002", title: "Verify", kind: "verify", intent: "verify", dependsOn: ["T001"], verifies: ["FEAT-A"] },
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
`;

function provider(): FakeProvider {
  return new FakeProvider(parseFakeScript(fakeScript));
}

describe("execution.inPlace", () => {
  it("runs in the checkout on the run branch and restores the original branch", async () => {
    const repo = setupRepo("on", ["execution:", "  inPlace: true", "  commitPerTask: true"]);
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-inplace"), JSON.stringify(planFor()));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider(), log: () => {} });
    expect(report.status).toBe("succeeded");

    // Ran in the checkout itself; no worktree was created.
    expect(report.worktree).toBe(repo);
    expect(report.branch).toBe(`spc/one-file/${report.runId}`);
    expect(existsSync(paths.worktreesDir) && readdirSync(paths.worktreesDir).length > 0).toBe(false);

    // The checkout is back on the original branch; task files live only on
    // the run branch.
    expect(gitOk(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(existsSync(path.join(repo, "src", "a.mjs"))).toBe(false);
    expect(gitOk(repo, ["show", `${report.branch}:src/a.mjs`])).toContain("marker-a");

    // Per-task commits landed on the run branch, and the run transition
    // diff contains only the task file - no spc-owned state.
    const subjects = gitOk(repo, ["log", "--format=%s", `${report.baseRevision}..${report.branch}`]);
    expect(subjects).toContain("spc: task T001 (run ");
    const changed = gitOk(repo, ["diff", "--name-only", `${report.baseRevision}..${report.branch}`])
      .trim()
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(changed).toEqual(["src/a.mjs"]);
    expect(report.changedFileCount).toBe(1);

    // metadata records the original branch for the restore.
    const meta = JSON.parse(readFileSync(paths.metadataFile(report.runId), "utf8")) as { originalBranch?: string };
    expect(meta.originalBranch).toBe("main");
  }, 120_000);

  it("rejects inPlace with parallelism > 1", async () => {
    const repo = setupRepo("par", ["execution:", "  inPlace: true", "  parallelism: 2"]);
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-inplace"), JSON.stringify(planFor()));

    await expect(
      applyPlan({ repoRoot: repo }, { providerFactory: async () => provider(), log: () => {} }),
    ).rejects.toThrow(/inPlace requires execution\.parallelism 1/);
    // Nothing was checked out or left behind.
    expect(gitOk(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
  }, 120_000);
});
