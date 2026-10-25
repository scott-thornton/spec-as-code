import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/portable-candidates.yaml (PC-001, PC-002 CLI face):
// save-candidate persists immutable provenance (from a STALE request -
// composition against an expired request is legal); respond
// --from-candidate admits via atomic claim; non-executor roles are
// refused.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-candcli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function gitsh(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "stale"), { recursive: true });
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "t@t"]);
gitsh(["config", "user.name", "t"]);
writeFileSync(path.join(root, ".keep"), "", "utf8");
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);

const SCHEMA = {
  type: "object",
  required: ["status", "summary", "changes", "commands", "observations", "evidenceCandidates", "followups"],
  properties: { status: { type: "string" }, summary: { type: "string" }, changes: { type: "array" }, commands: { type: "array" }, observations: { type: "array" }, evidenceCandidates: { type: "array" }, followups: { type: "array" } },
};
const VALUE = { status: "completed", summary: "composed off the clock", changes: [], commands: [], observations: [], evidenceCandidates: [], followups: [] };
writeFileSync(path.join(root, "answer.json"), JSON.stringify(VALUE), "utf8");

function payloadPrompt(task: unknown, revision: string): string {
  return `--- harness instructions ---\nanswer\n\nExecute the following task. Respond with JSON only.\n\n${JSON.stringify({ spec: { id: "s" }, repository: { revision }, task, allowedWritePaths: ["src/**"] }, null, 2)}`;
}

// The ORIGINAL request: expired long ago (stale - composition against
// it is legal; it confers no authority and is never resurrected).
writeFileSync(
  path.join(root, ".spc", "harness", "stale", "executor-T001@1-1.json"),
  JSON.stringify({ id: "executor-T001@1-1", role: "executor", key: "T001@1", schemaName: "ExecutorResult", jsonSchema: SCHEMA, system: "sys", prompt: payloadPrompt({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), createdAt: "2026-10-20T00:00:00.000Z" }),
  "utf8",
);
// A planner request: candidates are executors-only in v1.
writeFileSync(
  path.join(root, ".spc", "harness", "pending", "planner-planner@1-1.json"),
  JSON.stringify({ id: "planner-planner@1-1", role: "planner", key: "planner@1", schemaName: "PlannerOutput", jsonSchema: { type: "object" }, system: "sys", prompt: payloadPrompt({ id: "P" }, "a".repeat(40)), createdAt: new Date().toISOString() }),
  "utf8",
);

let candidateId = "";

describe("portable candidates through the CLI (portable-candidates)", () => {
  it("save-candidate persists an immutable candidate from a STALE executor request (PC-001)", () => {
    const r = sh(["agent", "save-candidate", "--file", "answer.json", "--request", "executor-T001@1-1", "--by", "composer"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/cand-[a-z0-9]+/i);
    candidateId = /cand-[a-z0-9]+/i.exec(r.stdout)?.[0] ?? "";
    expect(candidateId).toBeTruthy();
  });

  it("a non-executor request is refused (PC-001)", () => {
    const r = sh(["agent", "save-candidate", "--file", "answer.json", "--request", "planner-planner@1-1"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("CANDIDATE_ROLE_UNSUPPORTED");
  });

  it("a matching LIVE successor admits the candidate via claim (PC-002)", () => {
    writeFileSync(
      path.join(root, ".spc", "harness", "pending", "executor-T001@2-1.json"),
      JSON.stringify({ id: "executor-T001@2-1", role: "executor", key: "T001@2", schemaName: "ExecutorResult", jsonSchema: SCHEMA, system: "sys", prompt: payloadPrompt({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), createdAt: new Date().toISOString() }),
      "utf8",
    );
    const r = sh(["agent", "respond", "executor-T001@2-1", "--from-candidate", candidateId]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("executor-T001@2-1");
    expect(r.stdout).toContain(candidateId);
  });

  it("the stale ORIGINAL request is never resurrected (PC-002)", () => {
    const r = sh(["agent", "respond", "executor-T001@1-1", "--from-candidate", candidateId]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("CANDIDATE_REQUEST_NOT_LIVE");
  });

  it("a DRIFTED successor rejects the attempt and preserves the candidate for another", () => {
    writeFileSync(path.join(root, "answer2.json"), JSON.stringify(VALUE), "utf8");
    const save = sh(["agent", "save-candidate", "--file", "answer2.json", "--request", "executor-T001@1-1"]);
    const cid = /cand-[a-z0-9]+/i.exec(save.stdout)?.[0] ?? "";
    expect(cid).toBeTruthy();
    writeFileSync(
      path.join(root, ".spc", "harness", "pending", "executor-T003@1-1.json"),
      JSON.stringify({ id: "executor-T003@1-1", role: "executor", key: "T003@1", schemaName: "ExecutorResult", jsonSchema: SCHEMA, system: "sys", prompt: payloadPrompt({ id: "T003", targets: { write: ["src/**"] } }, "a".repeat(40)), createdAt: new Date().toISOString() }),
      "utf8",
    );
    const r = sh(["agent", "respond", "executor-T003@1-1", "--from-candidate", cid]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("CANDIDATE_FINGERPRINT_MISMATCH");
    // Preserved: a matching successor can still claim it.
    writeFileSync(
      path.join(root, ".spc", "harness", "pending", "executor-T004@1-1.json"),
      JSON.stringify({ id: "executor-T004@1-1", role: "executor", key: "T004@1", schemaName: "ExecutorResult", jsonSchema: SCHEMA, system: "sys", prompt: payloadPrompt({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), createdAt: new Date().toISOString() }),
      "utf8",
    );
    const retry = sh(["agent", "respond", "executor-T004@1-1", "--from-candidate", cid]);
    expect(retry.status).toBe(0);
  });
});
