import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/unmediated-change-guard.yaml (UCG-002, UCG-003):
// the submission boundary is enforced on BOTH doors. `spc agent submit`
// refuses locally in seconds where it can resolve the execution tree
// and the task's write targets; `spc agent respond` (the door preflight
// cannot guard) refuses authoritatively with the same named
// diagnostic. Dirt outside the task's targets never triggers.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-ucg-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, "lib"), { recursive: true });
mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
writeFileSync(
  path.join(root, "specs", "ucg.yaml"),
  'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: ucg\n  title: UCG\ngoal: fixture\nrequirements:\n  - id: UCG-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: UCG-001-A\n        type: file\n        path: lib/a.ts\n        assert:\n          exists: true\n',
  "utf8",
);
writeFileSync(path.join(root, "outside.txt"), "unrelated\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);
const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const D = `sha256:${"0".repeat(64)}`;

// Run scaffolding the guard resolves: pending request -> runId -> run
// metadata planId -> plan task write targets.
mkdirSync(path.join(root, ".spc", "runs", "run-fixture-1"), { recursive: true });
mkdirSync(path.join(root, ".spc", "plans"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
writeFileSync(
  path.join(root, ".spc", "runs", "run-fixture-1", "metadata.json"),
  JSON.stringify({ runId: "run-fixture-1", kind: "apply", specId: "ucg", planId: "plan-fixture-1", baseRevision: rev, createdAt: new Date().toISOString() }),
  "utf8",
);
writeFileSync(
  path.join(root, ".spc", "plans", "plan-fixture-1.json"),
  JSON.stringify({
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-fixture-1", createdAt: new Date().toISOString() },
    spec: { id: "ucg", digest: D },
    repository: { revision: rev, snapshotDigest: D },
    tasks: [{ id: "T001", title: "fixture task", kind: "modify", intent: "fixture", targets: { write: ["lib/a.ts"] } }],
  }),
  "utf8",
);
const now = Date.now();
function plantRequest(id: string): void {
  writeFileSync(
    path.join(root, ".spc", "harness", "pending", `${id}.json`),
    JSON.stringify({ id, role: "executor", key: `${id.split("-")[1]}`, runId: "run-fixture-1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: '{"fixture":true}', createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString() }),
    "utf8",
  );
}
const answerFile = (changes: unknown): string => {
  const f = `answer-${Math.random().toString(36).slice(2, 8)}.json`;
  writeFileSync(path.join(root, f), JSON.stringify({ status: "completed", summary: "s", changes, commands: [], observations: [], evidenceCandidates: [], followups: [] }), "utf8");
  return f;
};

describe("unmediated-change-guard: submission boundary (UCG-002, UCG-003)", () => {
  it("clean tree + empty proposal submits normally", { timeout: 60_000 }, () => {
    plantRequest("executor-T001@1-1");
    const r = sh(["agent", "submit", "executor-T001@1-1", "--file", answerFile([]), "--no-preflight"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Answered executor-T001@1-1/);
  });

  it("submit refuses locally on unattributed dirt under task targets; the request stays pending", { timeout: 60_000 }, () => {
    plantRequest("executor-T001@1-2");
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 2;\n", "utf8");
    const r = sh(["agent", "submit", "executor-T001@1-2", "--file", answerFile([])]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/UNMEDIATED_CHANGES/);
    expect(r.stdout).toMatch(/lib\/a\.ts/);
    // Nothing was submitted: the request remains answerable.
    expect(sh(["agent", "list"]).stdout).toMatch(/executor-T001@1-2/);
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
  });

  it("respond - the door preflight cannot guard - refuses with the same diagnostic", { timeout: 60_000 }, () => {
    plantRequest("executor-T001@1-3");
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 3;\n", "utf8");
    const r = sh(["agent", "respond", "executor-T001@1-3", "--file", answerFile([])]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/UNMEDIATED_CHANGES/);
    expect(sh(["agent", "list"]).stdout).toMatch(/executor-T001@1-3/);
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
  });

  it("dirt outside the task's write targets never triggers", { timeout: 60_000 }, () => {
    plantRequest("executor-T001@1-4");
    writeFileSync(path.join(root, "outside.txt"), "changed elsewhere\n", "utf8");
    const r = sh(["agent", "submit", "executor-T001@1-4", "--file", answerFile([]), "--no-preflight"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Answered executor-T001@1-4/);
  });
});
