import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/agent-submit.yaml (AS-001): the disciplined tail as
// one command - chain validation, dry-run preflight, respond. A broken
// chain dies at step one with nothing submitted; a valid answer submits
// with the preflight on record. (The dry-run step needs a stageable
// answer, so the fixture carries a real file and a real patch op.)
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-asub-"));
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
mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
writeFileSync(path.join(root, "lib", "x.txt"), "alpha\nbeta\n", "utf8");
writeFileSync(path.join(root, "specs", "ok.yaml"), 'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: ok\n  title: OK\ngoal: fixture\nrequirements:\n  - id: OK-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: OK-001-A\n        type: command\n        command: "true"\n', "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

const now = Date.now();
function putPending(id: string): void {
  writeFileSync(
    path.join(root, ".spc", "harness", "pending", `${id}.json`),
    JSON.stringify({ id, role: "executor", key: "T001@1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: `p\n\n${JSON.stringify({ task: { id: "T001" } })}`, createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString() }),
    "utf8",
  );
}
putPending("executor-GOOD@1-1");
putPending("executor-BAD@1-1");

// A real, correctly-chained pair of ops (built by the tooling) and its
// reversed (order-broken) twin.
writeFileSync("/tmp/asub-a.anchor", "alpha");
writeFileSync("/tmp/asub-a.repl", "ALPHA");
writeFileSync("/tmp/asub-b.anchor", "beta");
writeFileSync("/tmp/asub-b.repl", "BETA");
const opA = JSON.parse(sh(["patch", "build", "lib/x.txt", "--anchor-file", "/tmp/asub-a.anchor", "--replacement-file", "/tmp/asub-a.repl"]).stdout);
writeFileSync(path.join(root, "ops-a.json"), JSON.stringify([opA]), "utf8");
const opB = JSON.parse(sh(["patch", "build", "lib/x.txt", "--anchor-file", "/tmp/asub-b.anchor", "--replacement-file", "/tmp/asub-b.repl", "--after", "ops-a.json"]).stdout);

function answerFile(name: string, changes: unknown[]): string {
  writeFileSync(path.join(root, name), JSON.stringify({ status: "completed", summary: "s", changes, commands: [], observations: [], evidenceCandidates: [], followups: [] }), "utf8");
  return name;
}

describe("spc agent submit (AS-001)", () => {
  it("an order-broken chain dies at step one with nothing submitted", { timeout: 120_000 }, () => {
    const broken = answerFile("broken.json", [opB, opA]);
    const r = sh(["agent", "submit", "executor-BAD@1-1", "--file", broken]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/PATCH_CHAIN_INVALID/);
    // Nothing was submitted: the request is still pending, no answer record.
    expect(sh(["agent", "list"]).stdout).toMatch(/executor-BAD@1-1/);
  });

  it("a valid answer submits with the preflight on record", { timeout: 180_000 }, () => {
    const good = answerFile("good.json", [opA, opB]);
    const r = sh(["agent", "submit", "executor-GOOD@1-1", "--file", good]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Answered executor-GOOD@1-1/);
  });
});
