import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/queue-legibility.yaml (QL-002 CLI face, QL-004
// presentation, QL-005 cancel): the surfaces an external agent actually
// touches - respond, list, wait, brief, run cancel - must show the true
// queue state or refuse with the reason. The incident moves (answer an
// elapsed orphan, re-answer a submitted-not-consumed request) all exit 0
// today; they must refuse with a next move in the message.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-queuelegcli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "answered"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "stale"), { recursive: true });
mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, "specs", "queue-legibility.yaml"), 'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: queue-legibility\n  title: QL\ngoal: fixture\nrequirements:\n  - id: QL-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: QL-001-A\n        type: command\n        command: "true"\n', "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
writeFileSync(path.join(root, ".keep"), "", "utf8");
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

const now = Date.now();
const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();

function putPending(id: string, overrides: Record<string, unknown>): void {
  const base = { id, role: "executor", key: "x@1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: "p", createdAt: iso(-60_000) };
  writeFileSync(path.join(root, ".spc", "harness", "pending", `${id}.json`), JSON.stringify({ ...base, ...overrides }), "utf8");
}
function putAnswered(id: string, answeredAt: string): void {
  writeFileSync(path.join(root, ".spc", "harness", "answered", `${id}.json`), JSON.stringify({ id, value: { status: "completed" }, answeredAt }), "utf8");
}

// The incident shapes, as fixtures.
putPending("executor-ELAPSED@1-2", { createdAt: iso(-30 * 60_000), expiresAt: iso(-15 * 60_000) });
putPending("executor-DUP@1-5", { expiresAt: iso(10 * 60_000) });
putAnswered("executor-DUP@1-5", iso(-30_000));
putPending("executor-RETRY@1-3", { expiresAt: iso(10 * 60_000), lastError: "status: required" });
putAnswered("executor-RETRY@1-3", iso(-2 * 60_000));
putPending("executor-LIVE@1-9", { expiresAt: iso(14 * 60_000) });
putPending("executor-ORPHAN@1-30", { createdAt: iso(-30 * 60_000), expiresAt: iso(-15 * 60_000) });
putAnswered("executor-ORPHAN@1-30", iso(-15 * 60_000));
putPending("executor-LEGACY@1-12", { createdAt: iso(-2 * 60_000) });

writeFileSync(path.join(root, "answer.json"), JSON.stringify({ status: "completed", summary: "fixed" }), "utf8");
writeFileSync(path.join(root, "retry.json"), JSON.stringify({ status: "completed", summary: "corrected" }), "utf8");

// A running run fixture for cancellation (same shape the runtime's own
// cancel test uses; unchained legacy events load fine).
const runDir = path.join(root, ".spc", "runs", "run-legtest");
mkdirSync(runDir, { recursive: true });
writeFileSync(path.join(runDir, "metadata.json"), JSON.stringify({ runId: "run-legtest", kind: "apply", specId: "queue-legibility", specDigest: "d", createdAt: iso(-5 * 60_000) }), "utf8");
writeFileSync(
  path.join(runDir, "state.json"),
  JSON.stringify({ runId: "run-legtest", kind: "apply", specId: "queue-legibility", specDigest: "d", status: "running", createdAt: iso(-5 * 60_000), updatedAt: iso(-5 * 60_000), modelCalls: 0, replans: 0, tasks: { T001: { taskId: "T001", status: "running", attempt: 1 } }, requirements: {} }),
  "utf8",
);
writeFileSync(
  path.join(runDir, "events.jsonl"),
  [
    JSON.stringify({ seq: 1, id: "a1b2c3d4-0000-4000-8000-000000000001", type: "RUN_CREATED", runId: "run-legtest", timestamp: iso(-5 * 60_000), payload: { specId: "queue-legibility" } }),
    JSON.stringify({ seq: 2, id: "a1b2c3d4-0000-4000-8000-000000000002", type: "TASK_STARTED", runId: "run-legtest", timestamp: iso(-4 * 60_000), payload: { taskId: "T001", attempt: 1 } }),
  ].join("\n") + "\n",
  "utf8",
);
putPending("executor-C1@1-1", { expiresAt: iso(10 * 60_000), runId: "run-legtest" });
putPending("executor-KEEP@1-1", { expiresAt: iso(10 * 60_000), runId: "run-other" });

describe("queue legibility (CLI)", () => {
  it("respond: an elapsed window refuses with REQUEST_WINDOW_ELAPSED and the next moves", () => {
    const r = sh(["agent", "respond", "executor-ELAPSED@1-2", "--file", "answer.json"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/REQUEST_WINDOW_ELAPSED/);
    expect(r.stdout).toMatch(/save-candidate/);
    expect(existsSync(path.join(root, ".spc", "harness", "answered", "executor-ELAPSED@1-2.json"))).toBe(false);
  });

  it("respond: a duplicate submission without lastError refuses, without declaring the consumer dead while the window is open", () => {
    const r = sh(["agent", "respond", "executor-DUP@1-5", "--file", "answer.json"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/REQUEST_ALREADY_ANSWERED/);
    expect(r.stdout).toMatch(/not been consumed/);
    expect(r.stdout).not.toMatch(/dead/);
  });

  it("respond: a rejected answer accepts the corrected retry", () => {
    const r = sh(["agent", "respond", "executor-RETRY@1-3", "--file", "retry.json"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Answered executor-RETRY@1-3/);
  });

  it("presentation: agent list derives live, elapsed, and window-unknown states with answered markers", () => {
    const r = sh(["agent", "list"]);
    expect(r.status).toBe(1); // pendings exist - the queue wants attention
    expect(r.stdout).toMatch(/executor-LIVE@1-9.*live/);
    expect(r.stdout).toMatch(/executor-ORPHAN@1-30.*elapsed/);
    expect(r.stdout).toMatch(/executor-LEGACY@1-12.*window unknown/);
    // The orphan is the incident shape: answered long ago, never consumed.
    expect(r.stdout).toMatch(/executor-ORPHAN@1-30.*answered/);
    // The rejected request still invites its retry.
    expect(r.stdout).toMatch(/executor-RETRY@1-3.*retry/);

    const j = sh(["agent", "list", "--format", "json"]);
    const parsed = JSON.parse(j.stdout) as Array<Record<string, unknown>>;
    const byId = new Map(parsed.map((x) => [x.id, x]));
    expect(byId.get("executor-LIVE@1-9")?.state).toBe("live");
    expect(byId.get("executor-ORPHAN@1-30")?.state).toBe("elapsed");
    expect(byId.get("executor-LEGACY@1-12")?.state).toBe("unknown");
    expect(byId.get("executor-ORPHAN@1-30")?.answeredAt).toBeTruthy();
  });

  it("presentation: brief renders the queue as one state line per pending request", () => {
    const r = sh(["brief"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/harness queue/);
    expect(r.stdout).toMatch(/executor-ORPHAN@1-30.*elapsed/);
    expect(r.stdout).toMatch(/executor-LIVE@1-9.*live/);
  });

  it("presentation: agent wait prints the derived line shape", () => {
    const r = sh(["agent", "wait", "--timeout", "5000"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/executor-LIVE@1-9.*live/);
    expect(r.stdout).toMatch(/elapsed/);
  });

  it("cancel: run cancel retires the run's stamped pendings into stale and reports them; others untouched", () => {
    const r = sh(["run", "cancel", "run-legtest"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/executor-C1@1-1/);
    expect(existsSync(path.join(root, ".spc", "harness", "stale", "executor-C1@1-1.json"))).toBe(true);
    expect(existsSync(path.join(root, ".spc", "harness", "pending", "executor-C1@1-1.json"))).toBe(false);
    // A different run's request and an unattributable one are not retired.
    expect(existsSync(path.join(root, ".spc", "harness", "pending", "executor-KEEP@1-1.json"))).toBe(true);
    expect(existsSync(path.join(root, ".spc", "harness", "pending", "executor-LEGACY@1-12.json"))).toBe(true);
    // And the retired request is out of the live queue's presentation.
    const list = sh(["agent", "list"]);
    expect(list.stdout).not.toMatch(/executor-C1@1-1/);
  });
});
