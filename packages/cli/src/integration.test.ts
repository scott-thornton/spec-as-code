import { afterAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { commitAll, gitOk } from "@spc/repo";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const MONOREPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

const tmpRoot = mkdtempSync(path.join(tmpdir(), "spc-cli-e2e-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function setupFixture(name: string): string {
  const repo = path.join(tmpRoot, name);
  cpSync(path.join(MONOREPO_ROOT, "fixtures", name), repo, { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  commitAll(repo, "fixture");
  return repo;
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function spc(cwd: string, args: string[]): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runDirOf(repo: string, runId: string): string {
  return path.join(repo, ".spc", "runs", runId);
}

describe("end-to-end: greeting fixture", () => {
  const repo = setupFixture("simple-node-service");

  it("spc spec validate accepts and prints the digest", () => {
    const r = spc(repo, ["spec", "validate", "specs/greeting.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Spec valid");
    expect(r.stdout).toContain("2 properties (1 must)");
    expect(r.stdout).toMatch(/sha256:[0-9a-f]{64}/);
  });

  it("spc spec show renders markdown", () => {
    const r = spc(repo, ["spec", "show", "specs/greeting.yaml", "--format", "markdown"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("# Greeting API");
    expect(r.stdout).toContain("GREETING-001");
  });

  it("spc plan generates and persists a validated plan", () => {
    const r = spc(repo, ["plan", "specs/greeting.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("T001");
    expect(r.stdout).toContain("GREETING-001 ✓");
    const plans = readdirSync(path.join(repo, ".spc", "plans")).filter((f) => f.endsWith(".json") && !f.endsWith(".approved.json"));
    expect(plans.length).toBe(1);
  });

  it("spc plan validate and spc plan show work", () => {
    expect(spc(repo, ["plan", "validate"]).status).toBe(0);
    const show = spc(repo, ["plan", "show"]);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("Execution");
  });

  it("spc apply runs the vertical slice to succeeded", () => {
    const r = spc(repo, ["apply"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("succeeded");
    expect(r.stdout).toMatch(/GREETING-001/);
    const runId = r.stdout.match(/Run (run-[a-z0-9-]+):/)?.[1];
    expect(runId).toBeTruthy();
    // Deterministic command evidence recorded.
    const evidence = readFileSync(path.join(runDirOf(repo, runId!), "evidence.jsonl"), "utf8");
    expect(evidence).toContain('"kind":"test"');
    expect(evidence).toContain('"outcome":"supports"');
    // Full event chain persisted.
    const events = readFileSync(path.join(runDirOf(repo, runId!), "events.jsonl"), "utf8");
    for (const type of ["RUN_CREATED", "TASK_STARTED", "FILE_CHANGED", "EVIDENCE_RECORDED", "PROPERTY_VERIFIED", "RUN_COMPLETED"]) {
      expect(events).toContain(`"type":"${type}"`);
    }
    expect(existsSync(path.join(runDirOf(repo, runId!), "summary.md"))).toBe(true);
  });

  it("spc status is requirement-oriented with evidence provenance", () => {
    const r = spc(repo, ["status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("✓ GREETING-001");
    expect(r.stdout).toContain("deterministic-test supports");
    expect(r.stdout).toContain("Tasks: 2 completed");
  });

  it("spc diff shows desired vs observed", () => {
    const r = spc(repo, ["diff"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Desired");
    expect(r.stdout).toMatch(/GREETING-001.*satisfied/);
  });

  it("spc followups reports none open", () => {
    const r = spc(repo, ["followups"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No open follow-ups");
  });

  it("spc verify detects drift: main tree does not satisfy the spec until the branch is merged", () => {
    const r = spc(repo, ["verify"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("unsatisfied");
    expect(r.stdout).toMatch(/GREETING-001/);
  });

  it("spc run show renders the run summary", () => {
    const runs = readdirSync(path.join(repo, ".spc", "runs"));
    const runId = runs.find((f) => f.startsWith("run-"));
    expect(runId).toBeTruthy();
    const r = spc(repo, ["run", "show", runId!]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`# Run ${runId}`);
    expect(r.stdout).toContain("satisfied");
  });

  it("spc verify --format github emits annotations and a step summary", () => {
    const summaryFile = path.join(tmpRoot, "step-summary.md");
    const r = spawnSync(
      process.execPath,
      [CLI, "verify", "--format", "github"],
      { cwd: repo, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: summaryFile } },
    );
    // Main tree is still unsatisfied (fix lives on the run branch): CI mode
    // must flag it as an error annotation.
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error title=");
    expect(r.stdout).toContain("GREETING-001");
    const summary = readFileSync(summaryFile, "utf8");
    expect(summary).toContain("### spc verification — greeting-api");
    expect(summary).toContain("| GREETING-001 | must | unsatisfied |");
  });
});

describe("end-to-end: replanning fixture", () => {
  const repo = setupFixture("plan-replan-service");

  it("plan and apply complete with an explicit replan", () => {
    expect(spc(repo, ["spec", "validate", "specs/session.yaml"]).status).toBe(0);
    expect(spc(repo, ["plan", "specs/session.yaml"]).status).toBe(0);
    const r = spc(repo, ["apply"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("succeeded");
    expect(r.stdout).toContain("replans: 1");
    const runId = r.stdout.match(/Run (run-[a-z0-9-]+):/)?.[1]!;
    expect(runId).toBeTruthy();

    const dir = runDirOf(repo, runId);
    const events = readFileSync(path.join(dir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"OBSERVATION_RECORDED"');
    expect(events).toContain('"type":"REPLAN_REQUESTED"');
    expect(events).toContain('"type":"PLAN_AMENDED"');
    expect(events).toContain('"addedTaskIds":["T003"]');

    // History preserved: original plan version and the amendment are on disk.
    expect(existsSync(path.join(dir, "plan-v1.json"))).toBe(true);
    const amendments = readdirSync(path.join(dir, "amendments"));
    expect(amendments.some((f) => f.startsWith("AM-"))).toBe(true);

    // The amended plan now targets the real location.
    const planFile = readdirSync(path.join(repo, ".spc", "plans")).find((f) => f.endsWith(".json") && !f.endsWith(".approved.json"))!;
    const plan = JSON.parse(readFileSync(path.join(repo, ".spc", "plans", planFile), "utf8")) as {
      tasks: { id: string; targets?: { write?: string[] } }[];
    };
    expect(plan.tasks.find((t) => t.id === "T003")?.targets?.write).toEqual(["packages/security/session.mjs"]);
  });

  it("status shows the property satisfied after the replan", () => {
    const r = spc(repo, ["status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("✓ SESSION-001");
  });
});

describe("spec imports end to end (§79)", () => {
  it("spc spec validate composes an imported invariants file", () => {
    const repo = path.join(tmpRoot, "imports-e2e");
    mkdirSync(path.join(repo, "specs"), { recursive: true });
    writeFileSync(
      path.join(repo, "specs", "_invariants.yaml"),
      [
        "apiVersion: spc.dev/v1alpha1",
        "kind: Spec",
        "metadata:",
        "  id: org-invariants",
        "  title: Org invariants",
        "goal: Shared invariants.",
        "requirements:",
        "  - id: SEC-001",
        "    statement: No plaintext secrets in src.",
        "    priority: must",
        "    acceptance:",
        "      - id: SEC-001-A",
        "        type: command",
        "        command: node -e 0",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(repo, "specs", "feature.yaml"),
      [
        "apiVersion: spc.dev/v1alpha1",
        "kind: Spec",
        "metadata:",
        "  id: feature-y",
        "  title: Feature Y",
        "goal: Works.",
        "imports:",
        "  - ./_invariants.yaml",
        "requirements:",
        "  - id: FEAT-001",
        "    statement: Feature works.",
        "    priority: must",
        "    dependsOn:",
        "      - SEC-001",
        "    acceptance:",
        "      - id: FEAT-001-A",
        "        type: command",
        "        command: node -e 0",
        "",
      ].join("\n"),
    );
    gitOk(repo, ["init", "-b", "main"]);
    commitAll(repo, "fixture");
    const r = spc(repo, ["spec", "validate", path.join(repo, "specs", "feature.yaml")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2 properties (2 must)");
    // And `verify` composes the same graph.
    const v = spc(repo, ["verify", path.join(repo, "specs", "feature.yaml")]);
    expect(v.status).toBe(0);
    expect(v.stdout).toContain("SEC-001");
    expect(v.stdout).toContain("FEAT-001");
  });

  it("spc spec validate reports a cross-file id collision with both files", () => {
    const repo = path.join(tmpRoot, "imports-collision");
    mkdirSync(path.join(repo, "specs"), { recursive: true });
    writeFileSync(
      path.join(repo, "specs", "a.yaml"),
      [
        "apiVersion: spc.dev/v1alpha1",
        "kind: Spec",
        "metadata: { id: spec-a, title: A }",
        "goal: g",
        "imports: [./b.yaml]",
        "requirements:",
        "  - id: DUP-001",
        "    statement: local",
        "    priority: may",
        "    acceptance:",
        "      - id: DUP-001-A",
        "        type: command",
        "        command: node -e 0",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(repo, "specs", "b.yaml"),
      [
        "apiVersion: spc.dev/v1alpha1",
        "kind: Spec",
        "metadata: { id: spec-b, title: B }",
        "goal: g",
        "requirements:",
        "  - id: DUP-001",
        "    statement: imported",
        "    priority: may",
        "    acceptance:",
        "      - id: DUP-001-B",
        "        type: command",
        "        command: node -e 0",
        "",
      ].join("\n"),
    );
    const r = spc(repo, ["spec", "validate", "specs/a.yaml"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("SPC1008");
    expect(r.stdout).toContain("b.yaml");
  });
});
