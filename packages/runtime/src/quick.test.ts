import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { runQuick } from "./quick.js";
import { replayRun } from "./replay.js";
import { loadPlanFile } from "./run.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-quick-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function setupRepo(name: string, script: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/plans/\n");
  writeFileSync(path.join(repo, ".spc", "config.yaml"), "version: 1\nprovider:\n  name: fake\n  script: .spc/fake-script.yaml\n");
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), script);
  commitAll(repo, "init");
  return repo;
}

// The fake planner must return a valid plan for the synthesized quick
// spec; the digest is irrelevant to the fake provider (it replays the
// scripted value), but validation needs coverage of QUICK-001.
const plannerPlan = (specId: string, digest: string) => ({
  apiVersion: "spc.dev/v1alpha1",
  kind: "Plan",
  metadata: { id: "ignored", createdAt: "now" },
  spec: { id: specId, digest },
  repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
  tasks: [
    { id: "T001", title: "Do it", kind: "modify", intent: "the quick intent", dependsOn: [], satisfies: ["QUICK-001"], targets: { write: ["src/greet.cjs"] } },
  ],
});

describe("spc quick", () => {
  it("a clean quick transaction: spec file, gate, full audit trail", async () => {
    const repo = setupRepo("clean", `planner:
  value: PLAN
executor:
  T001:
    status: completed
    summary: wrote it
    changes:
      - op: create
        path: src/greet.cjs
        content: |
          module.exports = { greet: () => "hello" };
`);
    // The fake planner replays the scripted value; patch it per-call by
    // wrapping: the quick spec id is dynamic, so intercept and rewrite.
    const base = new FakeProvider(parseFakeScript(`planner:\n  value: PLAN\nexecutor:\n  T001:\n    status: completed\n    summary: wrote it\n    changes:\n      - op: create\n        path: src/greet.cjs\n        content: |\n          module.exports = { greet: () => "hello" };\n`));
    const provider = {
      name: "quick-fake",
      model: "fake",
      generateStructured: async (request: { role: string; prompt: string; schema: unknown; schemaName?: string }) => {
        if (request.role === "planner" || request.role === "replanner") {
          const specId = /"id":\s*"(quick-[0-9]+)"/.exec(request.prompt)?.[1] ?? "quick-unknown";
          const digest = /"digest":\s*"(sha256:[0-9a-f]+)"/.exec(request.prompt)?.[1] ?? "";
          return { value: { plan: { tasks: plannerPlan(specId, digest).tasks }, observations: [], assumptions: [], followups: [] }, usage: { model: "fake", durationMs: 1 } };
        }
        return base.generateStructured({ ...request, requestId: "x" } as Parameters<typeof base.generateStructured>[0]);
      },
    };

    const result = await runQuick(
      { repoRoot: repo, intent: "make the greeting module exist", verifyCommand: 'node -e "require(\'./src/greet.cjs\')"' },
      { providerFactory: async () => provider as never, log: () => {} },
    );

    expect(result.report.status).toBe("succeeded");
    expect(result.exceededQuickShape).toBe(false);
    // A real spec file in the contract layer, a real plan, a real run.
    expect(existsSync(result.specPath)).toBe(true);
    const paths = spcPaths(repo);
    const events = readFileSync(paths.eventsFile(result.report.runId), "utf8");
    expect(events).toContain("RUN_ATTESTED");
    expect(events).toContain("QUICK-001");
    // The whole spine replays.
    const planFile = paths.planFile(latestPlan(paths));
    const replay = replayRun(paths.runsDir, result.report.runId, loadPlanFile(planFile));
    expect(replay.ok).toBe(true);
    expect(replay.chainStatus).toBe("chained");
  }, 120_000);

  it("fail-closed: an out-of-scope write fails, reverts, and quick reports exceeded shape", async () => {
    const repo = setupRepo("scope", `planner:
  value: PLAN
executor:
  T001:
    status: completed
    summary: oops
    changes:
      - op: create
        path: .github/workflows/smuggle.yml
        content: |
          SMUGGLED
`);
    const provider = {
      name: "quick-fake",
      model: "fake",
      generateStructured: async (request: { role: string; prompt: string }) => {
        if (request.role === "planner" || request.role === "replanner") {
          const specId = /"id":\s*"(quick-[0-9]+)"/.exec(request.prompt)?.[1] ?? "quick-unknown";
          const digest = /"digest":\s*"(sha256:[0-9a-f]+)"/.exec(request.prompt)?.[1] ?? "";
          return { value: { plan: { tasks: plannerPlan(specId, digest).tasks }, observations: [], assumptions: [], followups: [] }, usage: { model: "fake", durationMs: 1 } };
        }
        return {
          value: { status: "completed", summary: "oops", changes: [{ op: "create", path: ".github/workflows/smuggle.yml", content: "SMUGGLED\n" }], observations: [], evidenceCandidates: [], followups: [] },
          usage: { model: "fake", durationMs: 1 },
        };
      },
    };
    const result = await runQuick(
      { repoRoot: repo, intent: "something sneaky", verifyCommand: "true" },
      { providerFactory: async () => provider as never, log: () => {} },
    );
    // The task fails at the executor pre-flight (proposed out-of-scope
    // change rejected before touching disk); retries exhaust it. The run
    // may still end "succeeded" under completion semantics because the
    // gate (`true`) trivially passes on the unchanged tree - the
    // exceeded-shape signal is the contract with the caller.
    expect(result.exceededQuickShape).toBe(true);
    // Fail-closed: the forbidden file never persisted anywhere.
    expect(existsSync(path.join(result.report.worktree ?? repo, ".github/workflows/smuggle.yml"))).toBe(false);
  }, 120_000);
});

function latestPlan(paths: { plansDir: string }): string {
  const plans = readdirSync(paths.plansDir).filter((f) => f.endsWith(".json") && !f.endsWith(".approved.json")).sort();
  return plans[plans.length - 1]!.replace(/\.json$/, "");
}
