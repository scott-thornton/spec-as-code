import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/rehearsal-visibility.yaml (RV2-001): the answer
// record names HOW the answer was rehearsed (--rehearsed-with rendered
// by agent show), and the dry-run preflight prints the cumulative count
// and elapsed spend per request.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-rvis-"));
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
writeFileSync(
  path.join(root, ".spc", "harness", "pending", "executor-RV@1-1.json"),
  JSON.stringify({ id: "executor-RV@1-1", role: "executor", key: "RV@1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: `p\n\n${JSON.stringify({ task: { id: "T001" } })}`, createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString() }),
  "utf8",
);
writeFileSync("/tmp/rv-a.anchor", "alpha");
writeFileSync("/tmp/rv-a.repl", "ALPHA");
const opA = JSON.parse(sh(["patch", "build", "lib/x.txt", "--anchor-file", "/tmp/rv-a.anchor", "--replacement-file", "/tmp/rv-a.repl"]).stdout);
writeFileSync(path.join(root, "good.json"), JSON.stringify({ status: "completed", summary: "s", changes: [opA], commands: [], observations: [], evidenceCandidates: [], followups: [] }), "utf8");

describe("rehearsal visibility (RV2-001)", () => {
  it("submit --rehearsed-with dry-run records the shape on the answer and shows it; a second preflight prints cumulative cost", { timeout: 240_000 }, () => {
    // Two preflights so the second prints #2 with cumulative time: run
    // the dry-run once standalone, then submit (its preflight is #2).
    const first = sh(["agent", "dry-run", "executor-RV@1-1", "--file", "good.json"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/preflight #1/);

    const r = sh(["agent", "submit", "executor-RV@1-1", "--file", "good.json", "--rehearsed-with", "dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/rehearsed with: dry-run/);
    expect(r.stdout).toMatch(/preflight #2/);

    // The shape is on the answered record and rendered by show.
    const answer = JSON.parse(readFileSync(path.join(root, ".spc", "harness", "answered", "executor-RV@1-1.json"), "utf8")) as { rehearsedWith?: string };
    expect(answer.rehearsedWith).toBe("dry-run");
  });
});
