import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-budget-"));
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
      - op: create
        path: src/extra.cjs
        content: |
          module.exports = {};
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
    metadata: { id: "plan-budget", createdAt: "now" },
    spec: { id: "greet", digest: ir.digest },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      { id: "T001", title: "Write greet", kind: "modify", intent: "create src/greet.cjs", dependsOn: [], satisfies: ["FEAT-A"], targets: { write: ["src/greet.cjs", "src/extra.cjs"] } },
    ],
  };
}

async function run(repo: string): Promise<{ runId: string; status: string }> {
  const paths = spcPaths(repo);
  mkdirSync(paths.plansDir, { recursive: true });
  writeFileSync(paths.planFile("plan-budget"), JSON.stringify(planFor()));
  const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(fakeScript)), log: () => {} });
  return { runId: report.runId, status: report.status };
}

describe("budgets as signals", () => {
  it("exceeded budgets signal loudly but never change the outcome", { timeout: 120_000 }, async () => {
    const repo = setupRepo("tight", ["execution:", "  budgets:", "    wallTimeMs: 1", "    diffLines: 1", "    changedFiles: 1"]);
    const { runId, status } = await run(repo);
    const paths = spcPaths(repo);

    // The run still succeeds; the signal is an observation, not a verdict.
    expect(status).toBe("succeeded");

    const events = readFileSync(paths.eventsFile(runId), "utf8");
    const signals = (events.match(/"type":"BUDGET_SIGNAL"/g) ?? []).length;
    expect(signals).toBe(3); // wallTime, diffLines, changedFiles all exceeded
    expect(events).toContain('"kind":"diffLines"');

    const followups = JSON.parse(readFileSync(paths.followupsFile(runId), "utf8")) as { type: string; blocking: boolean; title: string }[];
    const budgetFollowups = followups.filter((f) => f.title.startsWith("Budget exceeded"));
    expect(budgetFollowups).toHaveLength(3);
    expect(budgetFollowups.every((f) => !f.blocking)).toBe(true);
  });

  it("no budgets configured: no signals, no noise", { timeout: 120_000 }, async () => {
    const repo = setupRepo("off", []);
    const { runId, status } = await run(repo);
    expect(status).toBe("succeeded");
    const events = readFileSync(spcPaths(repo).eventsFile(runId), "utf8");
    expect(events).not.toContain("BUDGET_SIGNAL");
  });
});
