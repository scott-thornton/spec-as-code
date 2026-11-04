import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/submit-refusal-feedback.yaml (SF-001..SF-003, red,
// committed pre-run): the fence writes what it says. A submit that
// refuses at any gate (chain check, submission guard, dry-run preflight)
// leaves the named cause on the pending request's lastError - the wire
// the dry-run's own stdout promises ("a submit would requeue with the
// same errors") - and the feedback is visible in agent show / agent
// list. Today every gate talks only to stdout and the queue stays deaf.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-srfb-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
/** The pending request's lastError (undefined when never written). */
function lastErrorOf(id: string): string | undefined {
  return (JSON.parse(readFileSync(path.join(root, ".spc", "harness", "pending", `${id}.json`), "utf8")) as { lastError?: string }).lastError;
}

// Fixture: a real tree for patch ops (lib/x.txt), a guard-resolvable run
// context (run metadata + plan with write targets on lib/a.ts), and
// per-leg pending requests.
mkdirSync(path.join(root, "lib"), { recursive: true });
mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, "lib", "x.txt"), "alpha\nbeta\n", "utf8");
writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
writeFileSync(
  path.join(root, "specs", "srfb.yaml"),
  'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: srfb\n  title: SRFB\ngoal: fixture\nrequirements:\n  - id: SRFB-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: SRFB-001-A\n        type: file\n        path: lib/a.ts\n        assert:\n          exists: true\n',
  "utf8",
);
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);
const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const D = `sha256:${"0".repeat(64)}`;

mkdirSync(path.join(root, ".spc", "runs", "run-fixture-1"), { recursive: true });
mkdirSync(path.join(root, ".spc", "plans"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
writeFileSync(
  path.join(root, ".spc", "runs", "run-fixture-1", "metadata.json"),
  JSON.stringify({ runId: "run-fixture-1", kind: "apply", specId: "srfb", planId: "plan-fixture-1", baseRevision: rev, createdAt: new Date().toISOString() }),
  "utf8",
);
writeFileSync(
  path.join(root, ".spc", "plans", "plan-fixture-1.json"),
  JSON.stringify({
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-fixture-1", createdAt: new Date().toISOString() },
    spec: { id: "srfb", digest: D },
    repository: { revision: rev, snapshotDigest: D },
    tasks: [{ id: "T001", title: "fixture task", kind: "modify", intent: "fixture", targets: { write: ["lib/a.ts"] } }],
  }),
  "utf8",
);

const now = Date.now();
function putPending(id: string, jsonSchema: unknown): void {
  writeFileSync(
    path.join(root, ".spc", "harness", "pending", `${id}.json`),
    JSON.stringify({ id, role: "executor", key: "T001@1", runId: "run-fixture-1", schemaName: "ExecutorResult", jsonSchema, system: "s", prompt: `p\n\n${JSON.stringify({ task: { id: "T001" } })}`, createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString() }),
    "utf8",
  );
}
const PERMISSIVE = { type: "object" };
const STRICT_STATUS = {
  type: "object",
  properties: { status: { type: "string", enum: ["completed", "failed", "blocked", "needs_replan"] }, summary: { type: "string" } },
  required: ["status", "summary"],
};
putPending("executor-CHAIN@1-1", PERMISSIVE);
putPending("executor-GUARD@1-1", PERMISSIVE);
putPending("executor-SCHEMA@1-1", STRICT_STATUS);
putPending("executor-CLEAN@1-1", PERMISSIVE);

// A real, correctly-chained pair of ops (built by the tooling) and the
// reversed twin for the chain-broken leg.
writeFileSync("/tmp/srfb-a.anchor", "alpha");
writeFileSync("/tmp/srfb-a.repl", "ALPHA");
writeFileSync("/tmp/srfb-b.anchor", "beta");
writeFileSync("/tmp/srfb-b.repl", "BETA");
const opA = JSON.parse(sh(["patch", "build", "lib/x.txt", "--anchor-file", "/tmp/srfb-a.anchor", "--replacement-file", "/tmp/srfb-a.repl"]).stdout);
writeFileSync(path.join(root, "ops-a.json"), JSON.stringify([opA]), "utf8");
const opB = JSON.parse(sh(["patch", "build", "lib/x.txt", "--anchor-file", "/tmp/srfb-b.anchor", "--replacement-file", "/tmp/srfb-b.repl", "--after", "ops-a.json"]).stdout);

function answerFile(name: string, answer: Record<string, unknown>): string {
  writeFileSync(path.join(root, name), JSON.stringify({ commands: [], observations: [], evidenceCandidates: [], followups: [], ...answer }), "utf8");
  return name;
}

describe("SF-001: submit gates write their refusal cause on the pending request", () => {
  it("a chain-broken changes array leaves lastError naming PATCH_CHAIN_INVALID and the applicator's code", { timeout: 120_000 }, () => {
    const broken = answerFile("broken.json", { status: "completed", summary: "s", changes: [opB, opA] });
    const r = sh(["agent", "submit", "executor-CHAIN@1-1", "--file", broken]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/PATCH_CHAIN_INVALID/);
    const fb = lastErrorOf("executor-CHAIN@1-1");
    expect(fb).toBeDefined();
    expect(fb!).toMatch(/PATCH_CHAIN_INVALID/);
    expect(fb!).toMatch(/PATCH_BASE_MISMATCH/);
    // The stdout says the feedback was recorded (SF-002).
    expect(r.stdout).toMatch(/feedback recorded/i);
    // The request stays pending.
    expect(sh(["agent", "list"]).stdout).toMatch(/executor-CHAIN@1-1/);
  });

  it("unmediated dirt under task targets leaves lastError naming UNMEDIATED_CHANGES", { timeout: 120_000 }, () => {
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 2;\n", "utf8");
    const r = sh(["agent", "submit", "executor-GUARD@1-1", "--file", answerFile("guard.json", { status: "completed", summary: "s", changes: [] })]);
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/UNMEDIATED_CHANGES/);
    const fb = lastErrorOf("executor-GUARD@1-1");
    expect(fb).toBeDefined();
    expect(fb!).toMatch(/UNMEDIATED_CHANGES/);
    expect(fb!).toMatch(/lib\/a\.ts/);
  });

  it("a clean submit writes no feedback - the pending record stays feedback-free until the run consumes it", { timeout: 180_000 }, () => {
    const good = answerFile("good.json", { status: "completed", summary: "s", changes: [opA, opB] });
    const r = sh(["agent", "submit", "executor-CLEAN@1-1", "--file", good]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Answered executor-CLEAN@1-1/);
    expect(lastErrorOf("executor-CLEAN@1-1")).toBeUndefined();
  });
});

describe("SF-002: the feedback is visible where agents look", () => {
  it("agent show renders the refusal feedback in its default output; agent list frames it neutrally", { timeout: 60_000 }, () => {
    const show = sh(["agent", "show", "executor-CHAIN@1-1"]);
    expect(show.status).toBe(0);
    expect(show.stdout).toMatch(/PATCH_CHAIN_INVALID/);
    const list = sh(["agent", "list"]);
    // The old label lies for pre-answer refusals; the new frame must not.
    expect(list.stdout).not.toMatch(/previous answer invalid/);
    expect(list.stdout).toMatch(/feedback/i);
  });
});

describe("SF-003: the preflight leg names the refusing check, not the exit code", () => {
  it("a schema-violating draft leaves lastError naming the schema issue - never just 'preflight refused'", { timeout: 120_000 }, () => {
    // status outside the enum: the dry-run's schema check fires before
    // any worktree exists; the chain check passes (no changes).
    const draft = answerFile("schema.json", { status: "finished", summary: "s", changes: [] });
    const r = sh(["agent", "submit", "executor-SCHEMA@1-1", "--file", draft]);
    expect(r.status).toBe(1);
    const fb = lastErrorOf("executor-SCHEMA@1-1");
    expect(fb).toBeDefined();
    expect(fb!).toMatch(/schema/i);
    expect(fb!).toMatch(/status|enum|finished/);
    expect(fb!).not.toMatch(/^preflight refused \(exit 1\)$/);
  });
});
