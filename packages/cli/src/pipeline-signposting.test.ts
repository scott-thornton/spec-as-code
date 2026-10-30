import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/pipeline-signposting.yaml (SG-002/003/004):
// completions name the next command and never assert a stage passed;
// brief derives each run's pipeline position; spc docs renders the
// bundled pipeline skill body plus derived command and skill catalogs.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const ROOT = new URL("../../../", import.meta.url).pathname;
const FIXTURE = path.join(ROOT, "fixtures", "simple-node-service");

function sh(cwd: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
function copyFixture(name: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), `spc-pipelinesign-${name}-`));
  spawnSync("cp", ["-R", `${FIXTURE}/.`, repo]);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
  return repo;
}

const planRepo = copyFixture("plan");
const greenRepo = (() => {
  const repo = mkdtempSync(path.join(tmpdir(), "spc-pipelinesign-green-"));
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "ok.yaml"), 'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: ok\n  title: OK\ngoal: fixture\nrequirements:\n  - id: OK-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: OK-001-A\n        type: command\n        command: "true"\n', "utf8");
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
})();
const briefRepo = (() => {
  const repo = mkdtempSync(path.join(tmpdir(), "spc-pipelinesign-brief-"));
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc", "harness", "pending"), { recursive: true });
  mkdirSync(path.join(repo, ".spc", "runs", "run-psg-1"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "psg.yaml"), 'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: psg\n  title: PSG\ngoal: fixture\nrequirements:\n  - id: PSG-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: PSG-001-A\n        type: command\n        command: "true"\n', "utf8");
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  const now = Date.now();
  writeFileSync(path.join(repo, ".spc", "harness", "pending", "executor-T001@1-1.json"), JSON.stringify({ id: "executor-T001@1-1", role: "executor", key: "T001@1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: "p", createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 14 * 60_000).toISOString(), runId: "run-psg-1" }), "utf8");
  writeFileSync(path.join(repo, ".spc", "runs", "run-psg-1", "metadata.json"), JSON.stringify({ runId: "run-psg-1", kind: "apply", specId: "psg", specDigest: "d", createdAt: new Date(now - 5 * 60_000).toISOString() }), "utf8");
  writeFileSync(path.join(repo, ".spc", "runs", "run-psg-1", "state.json"), JSON.stringify({ runId: "run-psg-1", kind: "apply", specId: "psg", specDigest: "d", status: "running", createdAt: new Date(now - 5 * 60_000).toISOString(), updatedAt: new Date(now - 4 * 60_000).toISOString(), modelCalls: 1, replans: 0, tasks: { T001: { taskId: "T001", status: "running", attempt: 1 } }, requirements: {} }), "utf8");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
})();
afterAll(() => {
  for (const r of [planRepo, greenRepo, briefRepo]) rmSync(r, { recursive: true, force: true });
});

describe("completion lines (SG-002)", () => {
  it("plan's completion names answer discipline and the queue command", { timeout: 120_000 }, () => {
    const r = sh(planRepo, ["plan", "specs/greeting.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("spc agent list");
    expect(r.stdout).toMatch(/answer discipline/i);
  });

  it("verify's green output names the adversarial pass, then the push", { timeout: 120_000 }, () => {
    const r = sh(greenRepo, ["verify", "specs/ok.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/adversarial/);
    expect(r.stdout).toMatch(/push/);
  });
});

describe("brief derives pipeline position (SG-003)", () => {
  it("a running run with a pending executor request renders awaiting answer, stage 4", { timeout: 60_000 }, () => {
    const r = sh(briefRepo, ["brief"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/awaiting answer/i);
    expect(r.stdout).toMatch(/stage 4/);
  });
});

describe("spc docs (SG-004)", () => {
  it("renders the bundled pipeline skill body, the command catalog, and the skill catalog", { timeout: 60_000 }, () => {
    const r = sh(briefRepo, ["docs"]);
    expect(r.status).toBe(0);
    // The pipeline section is the bundled skill's body, byte-for-byte
    // content included (single source, no second authored copy).
    const skill = readFileSync(path.join(ROOT, "packages", "cli", "skills", "pipeline", "SKILL.md"), "utf8");
    const doctrine = skill.slice(skill.indexOf("exit evidence is not done"));
    expect(r.stdout).toContain(doctrine.split("\n")[0]!.trim());
    // Commands catalog is derived from the commander registry.
    expect(r.stdout).toMatch(/apply/);
    expect(r.stdout).toMatch(/execute a plan in an isolated worktree, then verify/);
    // Skills catalog lists the shipped skills with their invocations.
    expect(r.stdout).toMatch(/rehearse/);
    expect(r.stdout).toMatch(/spc use-skill rehearse/);
  });
});
