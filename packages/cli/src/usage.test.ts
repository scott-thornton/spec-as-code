import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-usage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, ".spc"), { recursive: true });
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
writeFileSync(path.join(root, "f.txt"), "x\n", "utf8");
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

// Run one: patch op + create op, one executor retry with a refusal.
const r1 = path.join(root, ".spc", "runs", "run-one");
mkdirSync(r1, { recursive: true });
mkdirSync(path.join(root, ".spc", "harness"), { recursive: true });
writeFileSync(path.join(r1, "usage.jsonl"),
  [
    JSON.stringify({ role: "planner", requestId: "a", inputDigest: "d", outputDigest: "d", durationMs: 1, status: "success", timestamp: "2026-10-19T10:00:00Z" }),
    JSON.stringify({ role: "executor", taskId: "T001", requestId: "b", inputDigest: "d", outputDigest: "d", durationMs: 2, status: "success", timestamp: "2026-10-19T10:01:00Z" }),
    JSON.stringify({ role: "executor", taskId: "T001", requestId: "c", inputDigest: "d", outputDigest: "d", durationMs: 3, status: "success", timestamp: "2026-10-19T10:02:00Z" }),
  ].join("\n") + "\n", "utf8");
// Answered executor values live in the harness answered dir keyed by request.
mkdirSync(path.join(root, ".spc", "harness", "answered"), { recursive: true });
writeFileSync(path.join(root, ".spc", "harness", "answered", "executor-T001@1-1.json"),
  JSON.stringify({ id: "executor-T001@1-1", value: { status: "failed", summary: "bad anchor", changes: [{ op: "patch", path: "f.txt", baseDigest: "sha256:x", anchor: "a".repeat(120), replacement: "b".repeat(80) }] }, answeredAt: "2026-10-19T10:01:00Z", answeredBy: "t" }), "utf8");
writeFileSync(path.join(root, ".spc", "harness", "answered", "executor-T001@2-1.json"),
  JSON.stringify({ id: "executor-T001@2-1", value: { status: "completed", summary: "ok", changes: [
    { op: "create", path: "g.txt", content: "Y".repeat(50) },
    { op: "patch", path: "f.txt", baseDigest: "sha256:x", anchor: "z".repeat(40), replacement: "w".repeat(60) },
  ] }, answeredAt: "2026-10-19T10:02:00Z", answeredBy: "t" }), "utf8");
writeFileSync(path.join(r1, "metadata.json"), JSON.stringify({ runId: "run-one", kind: "apply", specId: "s1", createdAt: "2026-10-19T10:00:00Z" }), "utf8");
writeFileSync(path.join(r1, "state.json"), JSON.stringify({ runId: "run-one", status: "succeeded", tasks: { T001: { taskId: "T001", status: "completed", attempt: 2, failure: { code: "PATCH_ANCHOR_ABSENT", message: "m" } } }, modelCalls: 2 }), "utf8");

describe("spc usage", () => {
  it("summarizes per-run economics: model calls, op distribution, patch usage rate, refusals", () => {
    const r = sh(["usage"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("run-one");
    expect(r.stdout).toMatch(/100%/);
  });

  it("--format json emits exact aggregates the corpus view sums", () => {
    const r = sh(["usage", "--format", "json"]);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    const run = j.runs.find((x: { runId: string }) => x.runId === "run-one");
    expect(run.modelCalls).toBe(3);
    expect(run.ops.patch).toBe(2);
    expect(run.ops.create).toBe(1);
    expect(run.ops.update).toBe(0);
    expect(run.patchUsageRate).toBe(1); // patch ops / (patch + update)
    expect(run.refusals).toBe(1); // retry failure code PATCH_*
    expect(run.emittedBytes.patch).toBe(120 + 80 + 40 + 60);
    expect(run.emittedBytes.create).toBe(50);
    expect(j.corpus.patchUsageRate).toBe(1);
  });

  it("is read-only", () => {
    const before = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim();
    sh(["usage"]);
    const after = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim();
    expect(after).toBe(before);
  });
});
