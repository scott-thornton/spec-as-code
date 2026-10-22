import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/composition-hardening.yaml (CLI half): spc agent
// validate is authoritative for known schema names (CH-002), plan validate
// flags shared-oracle task slicing (CH-004), and respond nudges toward the
// preflight when no record exists (CH-006).
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-ch-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: ch-cli-fixture
  title: fixture
goal: fixture
requirements:
  - id: CHF-001
    statement: First gate passes.
    priority: must
    acceptance:
      - id: CHF-001-A
        type: command
        command: node gates.cjs
        discriminating: true
  - id: CHF-002
    statement: Second gate passes.
    priority: must
    acceptance:
      - id: CHF-002-A
        type: command
        command: node gates.cjs
        discriminating: true
`;

function sh(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}

function gitsh(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, "src"), { recursive: true });
mkdirSync(path.join(root, ".spc", "plans"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
writeFileSync(path.join(root, "specs", "ch-cli-fixture.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, "gates.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\nnode_modules/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "test@example.com"]);
gitsh(["config", "user.name", "test"]);
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);

const digestLine = sh(["spec", "validate", "specs/ch-cli-fixture.yaml"]).stdout
  .split("\n")
  .find((l) => l.startsWith("Digest:"));
if (!digestLine) throw new Error("spec validate printed no digest");
const specDigest = digestLine.replace("Digest:", "").trim();

function planFile(name: string, tasks: unknown[]): string {
  const file = path.join(root, ".spc", "plans", `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: name, createdAt: "2026-10-22T00:00:00.000Z", generatedBy: { provider: "fake", model: "fake" } },
      spec: { id: "ch-cli-fixture", digest: specDigest },
      repository: { revision: "0000000000000000000000000000000000000000", snapshotDigest: "sha256:" + "0".repeat(64) },
      tasks,
      assumptions: [],
      followups: [],
    }),
    "utf8",
  );
  return file;
}

const task = (id: string, extra: Record<string, unknown>) => ({
  id,
  title: id,
  kind: "modify",
  intent: "do it",
  ...extra,
});

// Two sequential tasks writing the same path, satisfying properties whose
// discriminating criteria share one command: the shape that muted every
// intermediate preflight in the preflight-gates run.
const slicedPlan = planFile("ch-sliced", [
  task("T001", { targets: { write: ["src/**"] }, satisfies: ["CHF-001"], dependsOn: [] }),
  task("T002", { targets: { write: ["src/**"] }, satisfies: ["CHF-002"], dependsOn: ["T001"] }),
]);
// The same work as one task: one verification boundary, no finding.
const mergedPlan = planFile("ch-merged", [
  task("T001", { targets: { write: ["src/**"] }, satisfies: ["CHF-001", "CHF-002"], dependsOn: [] }),
]);

function pendingRequest(id: string, schemaName: string): void {
  writeFileSync(
    path.join(root, ".spc", "harness", "pending", `${id}.json`),
    JSON.stringify({
      id,
      role: schemaName === "PlannerOutput" ? "planner" : "executor",
      key: id.split("@")[1] ?? "1",
      schemaName,
      jsonSchema: { type: "object" },
      system: "sys",
      prompt: `--- harness instructions ---\nanswer\n\nExecute the following task. Respond with JSON only.\n\n${JSON.stringify({ spec: { id: "ch-cli-fixture" } })}`,
      createdAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

function draft(name: string, value: unknown): string {
  const file = path.join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

describe("spc agent validate is authoritative (CH-002)", () => {
  it("refuses a planner draft the runtime would refuse, though the JSON-Schema shadow passes", () => {
    pendingRequest("planner-p1@1-1", "PlannerOutput");
    const bad = draft("bad-plan", {
      plan: {
        tasks: [
          task("T001", { targets: { read: ["src/a.ts", "/tmp/leaked.ts"], write: ["src/**"] } }),
        ],
      },
      observations: [],
      assumptions: [],
      followups: [],
    });
    const r = sh(["agent", "validate", "planner-p1@1-1", "--file", bad]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/leaked|target|path/i);
  });

  it("still passes a clean planner draft", () => {
    const good = draft("good-plan", {
      plan: { tasks: [task("T001", { targets: { write: ["src/**"] }, satisfies: ["CHF-001"] })] },
      observations: [],
      assumptions: [],
      followups: [],
    });
    const r = sh(["agent", "validate", "planner-p1@1-1", "--file", good]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("OK");
  });
});

describe("plan validate flags shared-oracle slicing (CH-004)", () => {
  it("finds sequential same-path tasks whose properties share a command criterion", () => {
    const r = sh(["plan", "validate", slicedPlan]);
    expect(r.stdout).toContain("PLAN-SHARED-ORACLE");
  });

  it("does not flag the merged single task", () => {
    const r = sh(["plan", "validate", mergedPlan]);
    expect(r.stdout).not.toContain("PLAN-SHARED-ORACLE");
  });
});

describe("respond nudges toward the preflight record (CH-006)", () => {
  const answer = {
    status: "completed",
    summary: "s",
    changes: [],
    commands: [],
    observations: [],
    evidenceCandidates: [],
    followups: [],
  };

  it("prints the nudge when no preflight is on record", () => {
    pendingRequest("executor-T009@1-1", "ExecutorResult");
    const file = draft("t009-answer", answer);
    const r = sh(["agent", "respond", "executor-T009@1-1", "--file", file]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no preflight on record");
  });

  it("stays quiet once a preflight is recorded", () => {
    writeFileSync(
      path.join(root, ".spc", "harness", "preflights.jsonl"),
      JSON.stringify({ id: "executor-T010@1-1", at: "2026-10-22T00:00:00.000Z", staged: 1, refusals: [], criteria: { pass: 1, total: 1 }, gates: null }) + "\n",
      "utf8",
    );
    pendingRequest("executor-T010@1-1", "ExecutorResult");
    const file = draft("t010-answer", answer);
    const r = sh(["agent", "respond", "executor-T010@1-1", "--file", file]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("no preflight on record");
  });
});
