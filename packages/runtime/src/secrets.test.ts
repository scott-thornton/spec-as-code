import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-secrets-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: needs-secret
  title: Needs a secret
goal: Uses a declared secret.
environment:
  requiredSecrets:
    - SPC_TEST_TOKEN
requirements:
  - id: SEC-DEP-001
    statement: Works with the secret present.
    priority: must
    acceptance:
      - id: SEC-DEP-001-A
        type: command
        command: node -e 0
`;

function setupRepo(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(path.join(repo, ".spc", "config.yaml"), "version: 1\nprovider:\n  name: fake\n  script: .spc/fake-script.yaml\n");
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\nexecutor: {}\n");
  commitAll(repo, "init");
  return repo;
}

function planFor(): unknown {
  const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-s", createdAt: "now" },
    spec: { id: "needs-secret", digest: ir.digest },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      { id: "T001", title: "Verify", kind: "verify", intent: "verify", dependsOn: [], verifies: ["SEC-DEP-001"] },
    ],
  };
}

describe("§53 named secret references", () => {
  it("blocks before any execution when a required secret is absent, with a missing_secret follow-up", async () => {
    const repo = setupRepo("missing");
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-s"), JSON.stringify(planFor()));
    const prev = process.env.SPC_TEST_TOKEN;
    delete process.env.SPC_TEST_TOKEN;
    try {
      const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript("planner:\n  value: {}\n")), log: () => {} });
      expect(report.status).toBe("blocked");
      const f = report.followups.find((x) => x.type === "missing_secret" && x.status === "open");
      expect(f?.title).toContain("SPC_TEST_TOKEN");
      const log = readFileSync(paths.eventsFile(report.runId), "utf8");
      expect(log).toContain('"secret":"SPC_TEST_TOKEN"');
      // No worktree was created - blocked before execution.
      expect(report.worktree).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.SPC_TEST_TOKEN = prev;
    }
  }, 60_000);

  it("proceeds to verification when the secret is present", async () => {
    const repo = setupRepo("present");
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-s"), JSON.stringify(planFor()));
    process.env.SPC_TEST_TOKEN = "set-for-this-test";
    try {
      const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript("planner:\n  value: {}\n")), log: () => {} });
      expect(report.status).toBe("succeeded");
      expect(report.followups.filter((f) => f.type === "missing_secret")).toHaveLength(0);
    } finally {
      delete process.env.SPC_TEST_TOKEN;
    }
  }, 60_000);
});
