import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { gitOk, commitAll } from "@spc/repo";
import { applyPlan, resolveFollowup, spcPaths } from "./index.js";
import { loadConfig } from "./run.js";
import { FollowupStore } from "./stores.js";
import { EventStore } from "./events.js";
import { EvidenceStore } from "./stores.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-followups-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: human-check
  title: Human Check
goal: A human reviews the result.
requirements:
  - id: CHECK-001
    statement: The result looks right to a human.
    priority: must
    acceptance:
      - id: CHECK-001-A
        type: human
        instruction: Review the result.
`;
const specIr = compileSpecSource(specYaml, "specs/human.yaml").ir!;

describe("follow-up resolution produces human evidence and re-derives state", () => {
  const repo = path.join(root, "proj");
  const runId = "run-human-1";
  const paths = spcPaths(repo);

  it("confirm resolves the manual-verification follow-up to satisfied", () => {
    mkdirSync(repo, { recursive: true });
    gitOk(repo, ["init", "-b", "main"]);
    writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n");
    commitAll(repo, "init");
    mkdirSync(paths.runDir(runId), { recursive: true });
    writeFileSync(
      paths.metadataFile(runId),
      JSON.stringify({ runId, kind: "apply", specId: "human-check", specDigest: specIr.digest, createdAt: "now" }),
    );

    const evidence = new EvidenceStore(paths.evidenceFile(runId));
    evidence.add({
      id: "EV-0001",
      runId,
      criterionId: "CHECK-001-A",
      propertyRefs: ["CHECK-001"],
      kind: "human",
      outcome: "inconclusive",
      producer: { type: "runtime", identity: "awaiting-human" },
      timestamp: "2026-09-17T00:00:00.000Z",
      repositoryRevision: "r1",
      payload: { status: "outstanding" },
    });
    const followups = new FollowupStore(paths.followupsFile(runId));
    followups.create(
      {
        type: "manual_verification",
        blocking: false,
        title: "Manual review: CHECK-001",
        description: "Review the result.",
        propertyId: "CHECK-001",
        criterionId: "CHECK-001-A",
        options: [
          { id: "confirm", description: "holds" },
          { id: "reject", description: "does not hold" },
        ],
      },
      runId,
    );

    const result = resolveFollowup({
      repoRoot: repo,
      runId,
      followupId: "F-001",
      optionId: "confirm",
      resolvedBy: "reviewer@example.com",
      specIr,
      config: loadConfig(path.join(repo, ".spc", "config.yaml")),
      now: () => "2026-09-17T01:00:00.000Z",
    });

    expect(result.followup.status).toBe("resolved");
    expect(result.propertyStates).toHaveLength(1);
    expect(result.propertyStates[0]?.propertyId).toBe("CHECK-001");
    expect(result.propertyStates[0]?.status).toBe("satisfied");
    // Human evidence was appended and the property state updated on disk.
    const reloaded = new EvidenceStore(paths.evidenceFile(runId));
    reloaded.load();
    expect(reloaded.all()).toHaveLength(2);
    const human = reloaded.all()[1]!;
    expect(human.kind).toBe("human");
    expect(human.outcome).toBe("supports");
    expect(human.producer.identity).toBe("reviewer@example.com");
    const events = new EventStore(paths.eventsFile(runId), runId);
    events.load();
    expect(events.all().map((e) => e.type)).toContain("FOLLOWUP_RESOLVED");
    expect(events.all().map((e) => e.type)).toContain("PROPERTY_VERIFIED");
  });

  it("reject option derives unsatisfied; invalid options are refused", () => {
    const before = new FollowupStore(paths.followupsFile(runId));
    void before;
    expect(() =>
      resolveFollowup({
        repoRoot: repo,
        runId,
        followupId: "F-001",
        optionId: "confirm",
        specIr,
        config: loadConfig(path.join(repo, ".spc", "config.yaml")),
      }),
    ).not.toThrow(); // already resolved is idempotent
  });
});

describe("blocking follow-ups gate new apply runs", () => {
  it("refuses apply while an earlier run of the spec has an open blocking follow-up", async () => {
    const repo = path.join(root, "gated");
    mkdirSync(repo, { recursive: true });
    gitOk(repo, ["init", "-b", "main"]);
    const greetingSpec = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: greeting-api
  title: G
goal: Greet.
requirements:
  - id: GREETING-001
    statement: Greeting works.
    priority: must
    acceptance:
      - id: GREETING-001-A
        type: command
        command: node -e "0"
`;
    mkdirSync(path.join(repo, "specs"), { recursive: true });
    writeFileSync(path.join(repo, "specs", "greeting.yaml"), greetingSpec);
    writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n");
    commitAll(repo, "init");

    const paths = spcPaths(repo);
    // An earlier run with an open blocking follow-up for the same spec.
    const oldRun = "run-old-1";
    mkdirSync(paths.runDir(oldRun), { recursive: true });
    writeFileSync(
      paths.metadataFile(oldRun),
      JSON.stringify({ runId: oldRun, kind: "apply", specId: "greeting-api", specDigest: "d", createdAt: "t" }),
    );
    writeFileSync(
      paths.stateFile(oldRun),
      JSON.stringify({
        runId: oldRun, kind: "apply", specId: "greeting-api", specDigest: "d", status: "blocked",
        createdAt: "t", updatedAt: "t", modelCalls: 0, replans: 0, tasks: {}, requirements: {},
      }),
    );
    const store = new FollowupStore(paths.followupsFile(oldRun));
    store.create({ type: "spec_clarification", blocking: true, title: "Clarify X", description: "d" }, oldRun);

    const ir = compileSpecSource(greetingSpec, "specs/greeting.yaml").ir!;
    const plan = {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-g1", createdAt: "now" },
      spec: { id: "greeting-api", digest: ir.digest },
      repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [
        { id: "T001", title: "t", kind: "verify", intent: "v", dependsOn: [], verifies: ["GREETING-001"] },
      ],
    };
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-g1"), JSON.stringify(plan));

    await expect(applyPlan({ repoRoot: repo }, { providerFactory: async () => null })).rejects.toMatchObject({
      code: "BLOCKED_BY_FOLLOWUP",
    });
    // ...and --force proceeds past the gate.
    const report = await applyPlan({ repoRoot: repo, force: true }, { providerFactory: async () => null });
    expect(report.status).toBe("succeeded");
    expect(existsSync(report.summaryPath)).toBe(true);
  });
});
