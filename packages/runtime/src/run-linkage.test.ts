import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import type { StructuredRequest } from "@spc/llm";
import type { LLMProvider, StructuredResponse } from "@spc/llm";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { spcPaths } from "./paths.js";

// Oracle for specs/run-linkage.yaml (RL-001, follow-up F-001 from
// run-mvt04np2): every dispatch inside a running apply carries its run
// linkage. queue-legibility shipped the stamping machinery but the
// runtime call sites that feed it (executeTask, generateAmendment x2 in
// apply.ts) sat outside that plan's write scopes - executor and
// replanner requests dispatched unstamped, window-unknown to every
// derived surface and unattributable to cancellation. The capture
// provider records what actually crossed the provider boundary during
// an apply that replans once.
const root = mkdtempSync(path.join(tmpdir(), "spc-runlinkage-"));
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

interface CapturedCall {
  role: string;
  key?: string;
  runId?: string;
}

/** Records every generateStructured request, delegates to the scripted fake. */
class CapturingProvider implements LLMProvider {
  readonly name = "capture";
  readonly model = "capture-agent";
  readonly calls: CapturedCall[] = [];

  constructor(private readonly inner: FakeProvider) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    this.calls.push({ role: request.role, key: request.key, ...(request.runId ? { runId: request.runId } : {}) });
    return this.inner.generateStructured(request);
  }
}

function setupRepo(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(
    path.join(repo, ".spc", "config.yaml"),
    ["version: 1", "provider:", "  name: fake", "  script: .spc/fake-script.yaml"].join("\n"),
  );
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\n");
  writeFileSync(
    path.join(repo, "tests", "dep.test.mjs"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("dep", () => { assert.ok(true); });\n',
  );
  commitAll(repo, "init");
  return repo;
}

function planFor(repo: string) {
  const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-x", createdAt: "now" },
    spec: { id: "bump-dep", digest: ir.digest },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      { id: "T001", title: "Upgrade dependency", kind: "modify", intent: "bump", dependsOn: [], satisfies: ["DEP-001"], targets: { write: ["lib/dep.mjs"] } },
    ],
  };
}

describe("run linkage at dispatch", () => {
  it("executor and replanner requests carry the dispatching run's id through one apply with a replan", { timeout: 120_000 }, async () => {
    const repo = setupRepo("linkage");
    const provider = new CapturingProvider(
      new FakeProvider(
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
      ),
    );
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-x"), JSON.stringify(planFor(repo)));
    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider, log: () => {} });
    expect(report.status).toBe("succeeded");
    expect(report.replans).toBe(1);

    const byRole = (role: string) => provider.calls.filter((c) => c.role === role);
    // Executor dispatches (before and after the replan) both carry the
    // run's id.
    const executorCalls = byRole("executor");
    expect(executorCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of executorCalls) {
      expect(call.runId).toBe(report.runId);
    }
    // The replanner dispatch carries it too.
    const replannerCalls = byRole("replanner");
    expect(replannerCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of replannerCalls) {
      expect(call.runId).toBe(report.runId);
    }
    // No dispatch claims any other run.
    for (const call of provider.calls) {
      if (call.runId !== undefined) expect(call.runId).toBe(report.runId);
    }
  });
});
