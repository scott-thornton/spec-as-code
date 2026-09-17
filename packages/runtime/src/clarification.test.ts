import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-clarify-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: header-api
  title: Header API
goal: Responses carry a version header.
requirements:
  - id: API-001
    statement: respond() includes the X-API-Version header.
    priority: must
    acceptance:
      - id: API-001-A
        type: command
        command: node -e 0
`;

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
  const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-c", createdAt: "now" },
    spec: { id: "header-api", digest: ir.digest },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      { id: "T001", title: "Add header", kind: "modify", intent: "add header", dependsOn: [], satisfies: ["API-001"], targets: { write: ["lib/respond.mjs"] } },
      { id: "T002", title: "Verify", kind: "verify", intent: "verify", dependsOn: ["T001"], verifies: ["API-001"] },
    ],
  };
}

// Executor blocks on attempt 1 with a clarification draft (the flash
// api-version-header failure mode), completes on attempt 2 after the
// runtime injected proceed-on-default guidance.
const blockThenComplete = `
executor:
  T001:
    status: blocked
    summary: version value unspecified
    failure:
      code: SPEC_AMBIGUITY
      message: spec does not define the version value
    followups:
      - type: spec_clarification
        blocking: true
        title: "Define the version value"
        description: "Spec API-001 does not define the X-API-Version value or its source."
        recommendedDefault: constant
  "T001@2":
    status: completed
    summary: proceeded with hardcoded version 1
    changes:
      - op: create
        path: lib/respond.mjs
        content: |
          export function respond(body) {
            return { status: 200, body, headers: { "X-API-Version": "1" } };
          }
    observations:
      - type: constraint
        statement: "Proceeded with the recommended default: hardcoded version constant 1"
        confidence: confirmed
`;

describe("clarification demotion, executor side (ADR-0013)", () => {
  it("policy on: executor blocking on only clarifications is demoted and auto-retried to completion", async () => {
    const repo = setupRepo("policy-on", ["execution:", "  proceedOnClarificationFollowups: true"]);
    const provider = new FakeProvider(parseFakeScript(blockThenComplete));
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-c"), JSON.stringify(planFor()));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider, log: () => {} });
    expect(report.status).toBe("succeeded");
    expect(report.requirements.find((r) => r.propertyId === "API-001")?.status).toBe("satisfied");

    const state = JSON.parse(readFileSync(paths.stateFile(report.runId), "utf8")) as {
      tasks: Record<string, { status: string; attempt: number; failure?: { code?: string } }>;
    };
    expect(state.tasks["T001"]?.status).toBe("completed");
    expect(state.tasks["T001"]?.attempt).toBe(2);

    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    expect(events).toContain("CLARIFICATION_PROCEED");
    expect(events).toContain('"demoted":true');
    // The decision the executor made on retry is recorded as an observation.
    expect(events).toContain("Proceeded with the recommended default");
  }, 120_000);

  it("policy off (strict): the same executor block ends the run blocked - no silent proceeding", async () => {
    const repo = setupRepo("policy-off", []);
    const provider = new FakeProvider(parseFakeScript(blockThenComplete));
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-c"), JSON.stringify(planFor()));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider, log: () => {} });
    expect(report.status).toBe("blocked");
    const blocking = report.followups.find((f) => f.type === "spec_clarification" && f.status === "open");
    expect(blocking).toBeTruthy();
    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    expect(events).not.toContain('"demoted":true');
  }, 120_000);

  it("policy on but blocking on a missing secret is NOT demoted", async () => {
    const secretBlock = `
executor:
  T001:
    status: blocked
    summary: needs deploy token
    failure:
      code: MISSING_SECRET
      message: DEPLOY_TOKEN is required
    followups:
      - type: missing_secret
        blocking: true
        title: "Missing secret DEPLOY_TOKEN"
        description: "Export DEPLOY_TOKEN."
`;
    const repo = setupRepo("secret-block", ["execution:", "  proceedOnClarificationFollowups: true"]);
    const provider = new FakeProvider(parseFakeScript(secretBlock));
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-c"), JSON.stringify(planFor()));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider, log: () => {} });
    expect(report.status).toBe("blocked");
    expect(report.followups.some((f) => f.type === "missing_secret" && f.status === "open")).toBe(true);
  }, 120_000);
});
