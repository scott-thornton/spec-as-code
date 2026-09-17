import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource, planDigest } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, git, gitOk } from "@spc/repo";
import type { Plan } from "@spc/schema";
import { applyPlan, resumeRun, type ApplyReport } from "./apply.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-apply-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function initRepo(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n");
  return repo;
}

function commitAllFiles(repo: string): void {
  commitAll(repo, "init");
}

const greetingSpecYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: greeting-api
  title: Greeting API
goal: Expose a greeting function that returns "hello".
requirements:
  - id: GREETING-001
    statement: Calling greeting returns "hello".
    priority: must
    acceptance:
      - id: GREETING-001-A
        type: command
        command: node --test "tests/*.test.mjs"
  - id: GREETING-002
    statement: The greeting module exists.
    priority: should
    acceptance:
      - id: GREETING-002-A
        type: file
        path: src/greeting.mjs
        assert:
          exists: true
`;

function greetingScript(): FakeProvider {
  return new FakeProvider(
    parseFakeScript(`
planner:
  value: {}
executor:
  T001:
    status: completed
    summary: Implemented greeting.
    changes:
      - op: create
        path: src/greeting.mjs
        content: |
          export function greeting() {
            return "hello";
          }
`),
  );
}

function greetingPlan(): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-greeting", createdAt: "2026-09-17T00:00:00.000Z" },
    spec: { id: "greeting-api", digest: compileSpecSource(greetingSpecYaml, "specs/greeting.yaml").ir!.digest },
    repository: { revision: "0000", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      {
        id: "T001",
        title: "Implement greeting",
        kind: "modify",
        intent: "create the greeting function",
        dependsOn: [],
        satisfies: ["GREETING-001"],
        targets: { read: ["tests/**"], write: ["src/greeting.mjs"] },
      },
      {
        id: "T002",
        title: "Verify greeting",
        kind: "verify",
        intent: "run acceptance",
        dependsOn: ["T001"],
        verifies: ["GREETING-001", "GREETING-002"],
      },
    ],
  };
}

function setupGreetingRepo(name: string): string {
  const repo = initRepo(name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "greeting.yaml"), greetingSpecYaml);
  writeFileSync(
    path.join(repo, "tests", "greeting.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { greeting } from "../src/greeting.mjs";',
      'test("greeting returns hello", () => {',
      '  assert.equal(greeting(), "hello");',
      "});",
      "",
    ].join("\n"),
  );
  commitAllFiles(repo);
  return repo;
}

const log: string[] = [];

async function applyGreeting(repo: string): Promise<ApplyReport> {
  const paths = spcPaths(repo);
  mkdirSync(paths.plansDir, { recursive: true });
  writeFileSync(paths.planFile("plan-greeting"), JSON.stringify(greetingPlan(), null, 2));
  return applyPlan({ repoRoot: repo }, { providerFactory: async () => greetingScript(), log: (l) => log.push(l) });
}

describe("applyPlan end-to-end (library level)", () => {
  let repo: string;
  let report: ApplyReport;

  beforeAll(async () => {
    repo = setupGreetingRepo("greeting");
    report = await applyGreeting(repo);
  });

  it("completes with succeeded status driven by requirement satisfaction", () => {
    expect(report.status).toBe("succeeded");
    expect(report.requirements.find((r) => r.propertyId === "GREETING-001")?.status).toBe("satisfied");
    expect(report.requirements.find((r) => r.propertyId === "GREETING-002")?.status).toBe("satisfied");
  });

  it("records deterministic evidence with provenance", () => {
    const evidenceFile = spcPaths(repo).evidenceFile(report.runId);
    expect(existsSync(evidenceFile)).toBe(true);
    const lines = readFileSync(evidenceFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const testEvidence = lines.find((e) => e.kind === "test");
    expect(testEvidence).toBeTruthy();
    expect(testEvidence!.outcome).toBe("supports");
    const diffEvidence = lines.find((e) => e.kind === "diff");
    expect(diffEvidence).toBeTruthy();
  });

  it("persists the full event chain and state projection", () => {
    const eventsFile = spcPaths(repo).eventsFile(report.runId);
    const types = readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { type: string }).type);
    for (const expected of ["RUN_CREATED", "SPEC_VALIDATED", "REPOSITORY_OBSERVED", "PLAN_VALIDATED", "TASK_STARTED", "FILE_CHANGED", "TASK_COMPLETED", "EVIDENCE_RECORDED", "PROPERTY_VERIFIED", "RUN_COMPLETED"]) {
      expect(types).toContain(expected);
    }
    const state = JSON.parse(readFileSync(spcPaths(repo).stateFile(report.runId), "utf8")) as { status: string; tasks: Record<string, { status: string }> };
    expect(state.status).toBe("succeeded");
    expect(state.tasks["T001"]?.status).toBe("completed");
    expect(state.tasks["T002"]?.status).toBe("completed");
  });

  it("commits results to an isolated branch and never touches main", () => {
    expect(report.branch).toMatch(/^spc\/greeting-api\//);
    expect(report.resultRevision).not.toBe(report.baseRevision);
    const main = gitOk(repo, ["rev-parse", "main"]).trim();
    expect(main).toBe(report.baseRevision);
    const worktreeGreeting = gitOk(report.worktree!, ["show", "HEAD:src/greeting.mjs"]);
    expect(worktreeGreeting).toContain("hello");
  });

  it("writes a run summary and leaves source repository clean", () => {
    expect(existsSync(report.summaryPath)).toBe(true);
    const summary = readFileSync(report.summaryPath, "utf8");
    expect(summary).toContain("GREETING-001");
    expect(summary).toContain("succeeded");
    const status = gitOk(repo, ["status", "--porcelain"]);
    expect(status.trim()).toBe("");
  });
});

describe("replanning during apply", () => {
  const sessionSpecYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: session-prefix
  title: Session Prefix
goal: Session tokens carry a prefix.
requirements:
  - id: SESSION-001
    statement: Session tokens are prefixed with sess_.
    priority: must
    acceptance:
      - id: SESSION-001-A
        type: command
        command: node --test "tests/*.test.mjs"
`;

  function setup(): string {
    const repo = initRepo("replan");
    mkdirSync(path.join(repo, "specs"), { recursive: true });
    mkdirSync(path.join(repo, "tests"), { recursive: true });
    mkdirSync(path.join(repo, "packages", "security"), { recursive: true });
    writeFileSync(path.join(repo, "specs", "session.yaml"), sessionSpecYaml);
    writeFileSync(
      path.join(repo, "tests", "session.test.mjs"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { sessionPrefix } from "../packages/security/session.mjs";',
        'test("session prefix", () => {',
        '  assert.equal(sessionPrefix(), "sess_");',
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(repo, "packages", "security", "session.mjs"),
      'export function sessionPrefix() {\n  return "";\n}\n',
    );
    commitAllFiles(repo);
    return repo;
  }

  function script(): FakeProvider {
    return new FakeProvider(
      parseFakeScript(`
planner:
  value: {}
executor:
  T001:
    status: needs_replan
    summary: Planned target does not exist; implementation lives elsewhere.
    replanReason: session implementation lives in packages/security
    observations:
      - type: architecture
        statement: The session implementation lives at packages/security/session.mjs, not src/auth/session.mjs.
        confidence: confirmed
        invalidates:
          taskIds: [T001]
  T003:
    status: completed
    summary: Implemented at the correct location.
    changes:
      - op: update
        path: packages/security/session.mjs
        content: |
          export function sessionPrefix() {
            return "sess_";
          }
replanner:
  T001:
    reason: planned target location was wrong
    operations:
      - op: replaceTask
        taskId: T001
        task:
          id: T003
          title: Implement session prefix at actual location
          kind: modify
          intent: update packages/security/session.mjs
          dependsOn: []
          satisfies: [SESSION-001]
          targets:
            write: [packages/security/session.mjs]
`),
    );
  }

  it("observation invalidates the task, amendment is validated, history preserved, run succeeds", async () => {
    const repo = setup();
    const ir = compileSpecSource(sessionSpecYaml, "specs/session.yaml").ir!;
    const plan: Plan = {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-session", createdAt: "2026-09-17T00:00:00.000Z" },
      spec: { id: "session-prefix", digest: ir.digest },
      repository: { revision: "0000", snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [
        {
          id: "T001",
          title: "Implement session prefix",
          kind: "modify",
          intent: "modify src/auth/session.mjs",
          dependsOn: [],
          satisfies: ["SESSION-001"],
          targets: { write: ["src/auth/session.mjs"] },
        },
        {
          id: "T002",
          title: "Verify session",
          kind: "verify",
          intent: "run acceptance",
          dependsOn: ["T001"],
          verifies: ["SESSION-001"],
        },
      ],
    };
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-session"), JSON.stringify(plan, null, 2));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => script(), log: () => {} });

    expect(report.status).toBe("succeeded");
    expect(report.replans).toBe(1);
    const events = readFileSync(paths.eventsFile(report.runId), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; payload?: Record<string, unknown> });
    expect(events.map((e) => e.type)).toContain("OBSERVATION_RECORDED");
    expect(events.map((e) => e.type)).toContain("REPLAN_REQUESTED");
    const amended = events.find((e) => e.type === "PLAN_AMENDED");
    expect(amended?.payload?.addedTaskIds).toEqual(["T003"]);
    // Original plan version preserved; amended plan persisted with new digest.
    expect(existsSync(path.join(paths.runDir(report.runId), "plan-v1.json"))).toBe(true);
    const amendedPlan = JSON.parse(readFileSync(paths.planFile("plan-session"), "utf8")) as Plan;
    expect(amendedPlan.tasks.map((t) => t.id).sort()).toEqual(["T002", "T003"]);
    expect(planDigest(amendedPlan)).not.toBe(planDigest(plan));
    // The requirement is satisfied with command evidence.
    expect(report.requirements.find((r) => r.propertyId === "SESSION-001")?.status).toBe("satisfied");
  });
});

describe("recovery after interruption", () => {
  function setup(): { repo: string; report: ApplyReport } {
    const repo = setupGreetingRepo("recover-src");
    return { repo, report: null as unknown as ApplyReport };
  }

  it("resumes an interrupted run from replayed events without duplicating completed work", async () => {
    // Build a repo, then simulate a crash mid-T001 by hand-crafting the
    // on-disk state an interrupted process leaves behind.
    const src = setupGreetingRepo("recover-crash");
    const paths = spcPaths(src);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-greeting"), JSON.stringify(greetingPlan(), null, 2));

    const runId = "run-crash-1";
    const runDir = paths.runDir(runId);
    mkdirSync(runDir, { recursive: true });
    const worktree = path.join(paths.worktreesDir, runId);
    gitOk(src, ["worktree", "add", "-b", `spc/greeting-api/${runId}`, worktree]);
    const meta = {
      runId,
      kind: "apply" as const,
      specId: "greeting-api",
      specDigest: compileSpecSource(greetingSpecYaml, "s").ir!.digest,
      planId: "plan-greeting",
      planDigest: "pending",
      baseRevision: "pending",
      branch: `spc/greeting-api/${runId}`,
      worktree,
      createdAt: "2026-09-17T00:00:00.000Z",
    };
    const revision = gitOk(src, ["rev-parse", "HEAD"]).trim();
    meta.baseRevision = revision;
    writeFileSync(paths.metadataFile(runId), JSON.stringify(meta, null, 2));

    const events = [
      { seq: 1, id: "e1", type: "RUN_CREATED", runId, timestamp: "2026-09-17T00:00:01.000Z", payload: { specId: "greeting-api" } },
      { seq: 2, id: "e2", type: "SPEC_LOADED", runId, timestamp: "2026-09-17T00:00:01.000Z", payload: {} },
      { seq: 3, id: "e3", type: "SPEC_VALIDATED", runId, timestamp: "2026-09-17T00:00:01.000Z", payload: {} },
      { seq: 4, id: "e4", type: "REPOSITORY_OBSERVED", runId, timestamp: "2026-09-17T00:00:01.000Z", payload: {} },
      { seq: 5, id: "e5", type: "PLAN_VALIDATED", runId, timestamp: "2026-09-17T00:00:01.000Z", payload: {} },
      { seq: 6, id: "e6", type: "TASK_READY", runId, timestamp: "2026-09-17T00:00:02.000Z", payload: { taskId: "T001", attempt: 1 } },
      { seq: 7, id: "e7", type: "TASK_STARTED", runId, timestamp: "2026-09-17T00:00:02.000Z", payload: { taskId: "T001", attempt: 1 } },
      // ... process killed here: no TASK_COMPLETED
    ];
    writeFileSync(paths.eventsFile(runId), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(
      paths.stateFile(runId),
      JSON.stringify({
        runId,
        kind: "apply",
        specId: "greeting-api",
        specDigest: meta.specDigest,
        planId: "plan-greeting",
        status: "running",
        createdAt: meta.createdAt,
        updatedAt: meta.createdAt,
        modelCalls: 0,
        replans: 0,
        tasks: { T001: { taskId: "T001", status: "running", attempt: 1 }, T002: { taskId: "T002", status: "pending", attempt: 0 } },
        requirements: {},
      }),
    );
    writeFileSync(
      paths.snapshotFile(runId),
      JSON.stringify({ revision, dirty: false, languages: [], manifests: [], directories: [], tests: [], commands: {}, relevantArtifacts: [], createdAt: meta.createdAt, digest: `sha256:${"0".repeat(64)}` }),
    );

    const report = await resumeRun({ repoRoot: src, resumeRunId: runId }, { providerFactory: async () => greetingScript(), log: () => {} });

    expect(report.status).toBe("succeeded");
    // T001 was re-executed as attempt 2 (interrupted attempt re-run), then T002 completed.
    const state = JSON.parse(readFileSync(paths.stateFile(runId), "utf8")) as { tasks: Record<string, { status: string; attempt: number }> };
    expect(state.tasks["T001"]?.status).toBe("completed");
    expect(state.tasks["T001"]?.attempt).toBe(2);
    expect(state.tasks["T002"]?.status).toBe("completed");
    expect(report.requirements.find((r) => r.propertyId === "GREETING-001")?.status).toBe("satisfied");
    // Only one greeting.mjs exists - no duplicated work side effects.
    const files = gitOk(report.worktree!, ["show", "HEAD:src/greeting.mjs"]);
    expect(files).toContain("hello");
  });
});

describe("preflight failures", () => {
  it("refuses to run against a dirty repository", async () => {
    const repo = setupGreetingRepo("dirty");
    writeFileSync(path.join(repo, "uncommitted.txt"), "x");
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-greeting"), JSON.stringify(greetingPlan(), null, 2));
    await expect(
      applyPlan({ repoRoot: repo }, { providerFactory: async () => greetingScript() }),
    ).rejects.toMatchObject({ code: "DIRTY_REPOSITORY" });
  });

  it("refuses when the plan no longer matches the spec digest", async () => {
    const repo = setupGreetingRepo("stale");
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    const stale = {
      ...greetingPlan(),
      spec: { id: "greeting-api", digest: `sha256:${"9".repeat(64)}` },
    };
    writeFileSync(paths.planFile("plan-greeting"), JSON.stringify(stale, null, 2));
    await expect(
      applyPlan({ repoRoot: repo }, { providerFactory: async () => greetingScript() }),
    ).rejects.toMatchObject({ code: "PLAN_INVALID" });
  });

  it("respects write-scope enforcement: out-of-scope writes fail the task", async () => {
    const repo = setupGreetingRepo("scope");
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    const plan = greetingPlan();
    // Executor will write package.json, which is out of the declared scope.
    const rogue = new FakeProvider(
      parseFakeScript(`
executor:
  T001:
    status: completed
    summary: rogue change
    changes:
      - op: create
        path: package.json
        content: '{"name": "rogue"}'
`),
    );
    writeFileSync(paths.planFile("plan-greeting"), JSON.stringify(plan, null, 2));
    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => rogue, log: () => {} });
    expect(report.status).toBe("failed");
    const events = readFileSync(paths.eventsFile(report.runId), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; payload?: Record<string, unknown> });
    const failed = events.find((e) => e.type === "TASK_FAILED");
    expect((failed?.payload?.error as { code?: string })?.code).toBe("OUT_OF_SCOPE_WRITE");
    // The branch HEAD stays at the base revision: the rogue change was never committed.
    const show = git(report.worktree!, ["show", "HEAD:package.json"]);
    expect(show.ok).toBe(false);
  });
});
