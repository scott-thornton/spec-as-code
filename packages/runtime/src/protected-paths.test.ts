import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, git, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-prot-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: greet
  title: Greeting module
goal: A greet module exists.
requirements:
  - id: FEAT-A
    statement: The greet module exists.
    priority: must
    acceptance:
      - id: FEAT-A-A
        type: file
        path: src/greet.cjs
        assert:
          contains: "greet"
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
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/plans/\n");
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
    metadata: { id: "plan-prot", createdAt: "now" },
    spec: { id: "greet", digest: ir.digest },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      { id: "T001", title: "Write greet", kind: "modify", intent: "create src/greet.cjs", dependsOn: [], satisfies: ["FEAT-A"], targets: { write: ["src/greet.cjs"] } },
    ],
  };
}

describe("verification.protectedPaths", () => {
  it("a task touching a protected verification asset fails with PROTECTED_PATH_WRITE", { timeout: 120_000 }, async () => {
    // The write target is legitimately declared - the violation is the
    // protection, not the scope: the agent may not grade its own homework.
    const repo = setupRepo("blocked", ["verification:", "  protectedPaths:", "    - \"src/**\""]);
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-prot"), JSON.stringify(planFor()));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(fakeScript)), log: () => {} });
    expect(report.status).toBe("failed");

    const state = JSON.parse(readFileSync(paths.stateFile(report.runId), "utf8")) as {
      tasks: Record<string, { status: string; failure?: { code: string } }>;
    };
    expect(state.tasks["T001"]?.status).toBe("failed");
    expect(state.tasks["T001"]?.failure?.code).toBe("PROTECTED_PATH_WRITE");

    const evidence = readFileSync(paths.evidenceFile(report.runId), "utf8");
    expect(evidence).toContain("PROTECTED_PATH_WRITE");

    // The forbidden write does not survive: it was reverted before the
    // failure, so the retry re-violates instead of inheriting an empty
    // delta and completing with the protected change in the tree.
    expect(existsSync(path.join(report.worktree!, "src", "greet.cjs"))).toBe(false);
  }, 120_000);

  it("command-mediated out-of-scope writes revert on violation and cannot be laundered by retry", { timeout: 120_000 }, async () => {
    // A criterion command with filesystem side effects bypasses the
    // executor's pre-flight (which only sees proposed response changes).
    // Without the revert, attempt 1 writes the file and fails; attempt 2
    // finds it already present, writes nothing, its delta comes back
    // empty, and the verify task completes with the forbidden file in
    // the tree - committed by finishRun.
    const launderingYaml = specYaml.replace(
      '      - id: FEAT-A-A\n        type: file\n        path: src/greet.cjs\n        assert:\n          contains: "greet"\n',
      '      - id: FEAT-A-A\n        type: file\n        path: src/greet.cjs\n        assert:\n          contains: "greet"\n      - id: FEAT-A-B\n        type: command\n        command: test -f smuggle.txt || echo smuggled > smuggle.txt\n',
    );
    const launderingIr = compileSpecSource(launderingYaml, "specs/spec.yaml").ir!;
    const repo = path.join(root, "laundry");
    mkdirSync(path.join(repo, "specs"), { recursive: true });
    mkdirSync(path.join(repo, ".spc"), { recursive: true });
    gitOk(repo, ["init", "-b", "main"]);
    writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/plans/\n");
    writeFileSync(path.join(repo, "specs", "spec.yaml"), launderingYaml);
    writeFileSync(
      path.join(repo, ".spc", "config.yaml"),
      ["version: 1", "provider:", "  name: fake", "  script: .spc/fake-script.yaml"].join("\n"),
    );
    writeFileSync(
      path.join(repo, ".spc", "fake-script.yaml"),
      "planner:\n  value: {}\nexecutor:\n  T001:\n    status: completed\n    summary: wrote\n    changes:\n      - op: create\n        path: src/greet.cjs\n        content: |\n          module.exports = { greet: () => \"hello\" };\n",
    );
    commitAll(repo, "init");
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(
      paths.planFile("plan-prot"),
      JSON.stringify({
        apiVersion: "spc.dev/v1alpha1",
        kind: "Plan",
        metadata: { id: "plan-prot", createdAt: "now" },
        spec: { id: "greet", digest: launderingIr.digest },
        repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
        tasks: [
          { id: "T001", title: "Write greet", kind: "modify", intent: "create src/greet.cjs", dependsOn: [], satisfies: ["FEAT-A"], targets: { write: ["src/greet.cjs"] } },
          { id: "T002", title: "Verify", kind: "verify", intent: "verify", dependsOn: ["T001"], verifies: ["FEAT-A"] },
        ],
      }),
    );
    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(fakeScript)), log: () => {} });
    // Both attempts violate and revert: attempt 2's command finds the
    // file ABSENT (attempt 1's revert removed it), writes it again, and
    // violates again - the violation cannot be laundered by retrying.
    const state = JSON.parse(readFileSync(paths.stateFile(report.runId), "utf8")) as {
      tasks: Record<string, { status: string; attempt: number; failure?: { code: string } }>;
    };
    expect(state.tasks["T002"]?.status).toBe("failed");
    expect(state.tasks["T002"]?.attempt).toBe(2);
    expect(state.tasks["T002"]?.failure?.code).toBe("OUT_OF_SCOPE_WRITE");
    // The forbidden file never reaches the result commit. (The run may
    // still end satisfied per completion semantics, and the FINAL sweep
    // re-runs criterion commands after the commit - sweeps do not fence
    // the tree; side-effect-free gates are the author's job.)
    const show = git(report.worktree!, ["show", `${report.branch}:smuggle.txt`]);
    expect(show.ok).toBe(false);
  }, 120_000);

  it("protection does not over-block: unrelated paths run untouched", { timeout: 120_000 }, async () => {
    const repo = setupRepo("passing", ["verification:", "  protectedPaths:", "    - \"tests/**\""]);
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-prot"), JSON.stringify(planFor()));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(fakeScript)), log: () => {} });
    expect(report.status).toBe("succeeded");
  }, 120_000);
});
