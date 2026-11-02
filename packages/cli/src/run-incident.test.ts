import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/run-incident-surface.yaml: spc run show is the
// complete incident surface. Receipts: a sibling agent's hand-rolled
// state.json probe guessed the field shape wrong (failureReason ->
// blank reasons) and fell back to grep; the answering agent here ran
// the same probes dozens of times; criterion IDs were cross-referenced
// to spec text by hand while spec-snapshot.yaml sat in the run dir
// unrendered. One command must answer: what state, which task failed
// with what code, what refused, what is pending against its window,
// and what does the failing criterion actually demand.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-ris-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});
function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: ris
  title: fixture
goal: A gate exists.
requirements:
  - id: RIS-001
    statement: The gate exists and passes.
    priority: must
    acceptance:
      - id: RIS-001-A
        type: command
        command: node gate.cjs
        discriminating: true
`;

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc", "runs", "run-fixture-1"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
writeFileSync(path.join(root, "specs", "ris.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, "gate.cjs"), "process.exit(0);\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

const now = Date.now();
const D = "sha256:" + "0".repeat(64);
writeFileSync(
  path.join(root, ".spc", "runs", "run-fixture-1", "metadata.json"),
  JSON.stringify({ runId: "run-fixture-1", kind: "apply", specId: "ris", specDigest: D, planId: "plan-ris", createdAt: new Date(now - 30 * 60_000).toISOString() }),
  "utf8",
);
// The exact text the run was composed against.
writeFileSync(path.join(root, ".spc", "runs", "run-fixture-1", "spec-snapshot.yaml"), SPEC, "utf8");
writeFileSync(
  path.join(root, ".spc", "runs", "run-fixture-1", "state.json"),
  JSON.stringify({
    runId: "run-fixture-1",
    kind: "apply",
    specId: "ris",
    specDigest: D,
    planId: "plan-ris",
    status: "running",
    createdAt: new Date(now - 30 * 60_000).toISOString(),
    updatedAt: new Date(now - 2 * 60_000).toISOString(),
    modelCalls: 3,
    replans: 0,
    tasks: {
      T001: { taskId: "T001", status: "failed", attempt: 2, failure: { code: "OUT_OF_SCOPE_WRITE", message: "OUT_OF_SCOPE_WRITE: lib/x.ts does not match any declared write target" } },
      T002: { taskId: "T002", status: "running", attempt: 1 },
    },
    requirements: { "RIS-001": { propertyId: "RIS-001", status: "unsatisfied", evidenceIds: ["EV-0001"], updatedAt: new Date(now).toISOString(), reason: "criterion RIS-001-A contradicted (command evidence contradicts)" } },
  }),
  "utf8",
);
writeFileSync(
  path.join(root, ".spc", "runs", "run-fixture-1", "events.jsonl"),
  [
    { seq: 1, type: "RUN_CREATED", runId: "run-fixture-1", timestamp: new Date(now - 30 * 60_000).toISOString(), payload: {} },
    { seq: 2, type: "TASK_SUBMISSION_REFUSED", runId: "run-fixture-1", timestamp: new Date(now - 20 * 60_000).toISOString(), payload: { taskId: "T001", attempt: 2, code: "UNMEDIATED_CHANGES", message: "unmediated changes under the task's write targets" } },
    { seq: 3, type: "TASK_FAILED", runId: "run-fixture-1", timestamp: new Date(now - 2 * 60_000).toISOString(), payload: { taskId: "T001", attempt: 2, error: { code: "OUT_OF_SCOPE_WRITE", message: "OUT_OF_SCOPE_WRITE: lib/x.ts" } } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
  "utf8",
);
writeFileSync(
  path.join(root, ".spc", "harness", "pending", "executor-T002@1-5.json"),
  JSON.stringify({ id: "executor-T002@1-5", role: "executor", key: "T002@1", runId: "run-fixture-1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: "{}", createdAt: new Date(now - 5 * 60_000).toISOString(), expiresAt: new Date(now + 55 * 60_000).toISOString() }),
  "utf8",
);

describe("run incident surface (RIS-001..004)", () => {
  it("a live run renders state, task failures with codes, pending inventory with windows, and the spec section with criterion demands", { timeout: 60_000 }, () => {
    const r = sh(["run", "show", "run-fixture-1"]);
    expect(r.status).toBe(0);

    // RIS-001: task table with the real field shape - failure.code inline.
    expect(r.stdout).toMatch(/T001.*failed/);
    expect(r.stdout).toContain("OUT_OF_SCOPE_WRITE");
    expect(r.stdout).toMatch(/T002.*running/);
    // Pending inventory with age and window against expiresAt.
    expect(r.stdout).toContain("executor-T002@1-5");
    expect(r.stdout).toMatch(/window/i);

    // RIS-002: failure-shaped recent events with their codes.
    expect(r.stdout).toContain("TASK_SUBMISSION_REFUSED");
    expect(r.stdout).toContain("UNMEDIATED_CHANGES");

    // RIS-003: spec section - id, drift badge (snapshot matches live), demands.
    expect(r.stdout).toContain("ris");
    expect(r.stdout).toMatch(/drift/i);
    expect(r.stdout).toMatch(/matched|matches|no drift/i);
    expect(r.stdout).toContain("RIS-001");
    expect(r.stdout).toContain("The gate exists and passes.");
    expect(r.stdout).toContain("node gate.cjs");
  });

  it("a drifted live spec file is named as drift", { timeout: 60_000 }, () => {
    writeFileSync(path.join(root, "specs", "ris.yaml"), SPEC.replace("node gate.cjs", "node other.cjs"), "utf8");
    const r = sh(["run", "show", "run-fixture-1"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/drifted/i);
    writeFileSync(path.join(root, "specs", "ris.yaml"), SPEC, "utf8");
  });

  it("a finalized run prints the summary and still carries the spec section", { timeout: 60_000 }, () => {
    writeFileSync(path.join(root, ".spc", "runs", "run-fixture-1", "summary.md"), "# Run run-fixture-1\n\nCompleted summary text.\n", "utf8");
    const r = sh(["run", "show", "run-fixture-1"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Completed summary text.");
    expect(r.stdout).toContain("node gate.cjs");
  });
});
