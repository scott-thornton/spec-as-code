import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/skew-carveout.yaml SC-002 (red, committed pre-run):
// both CLI doors thread verification.protectedPaths into the guard, so
// an author-side oracle amendment (protected-path commit after the
// dispatch baseline) no longer refuses every subsequent submit - har's
// phase-18 false refusals. Control: a source commit still refuses.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-skc-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(cwd: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function fixture(name: string, amendProtected: boolean): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc", "runs", "run-fixture-1"), { recursive: true });
  mkdirSync(path.join(repo, ".spc", "plans"), { recursive: true });
  mkdirSync(path.join(repo, ".spc", "harness", "pending"), { recursive: true });
  writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(path.join(repo, "tests", "a.test.ts"), "test\n", "utf8");
  writeFileSync(
    path.join(repo, "specs", "skc.yaml"),
    'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: skc\n  title: SKC\ngoal: fixture\nrequirements:\n  - id: SKC-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: SKC-001-A\n        type: file\n        path: src/a.ts\n        assert:\n          exists: true\n',
    "utf8",
  );
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  writeFileSync(
    path.join(repo, ".spc", "config.yaml"),
    "version: 1\nprovider:\n  name: harness\nverification:\n  protectedPaths:\n    - \"tests/**\"\n",
    "utf8",
  );
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
  const rev = git(repo, ["rev-parse", "HEAD"]).trim();
  const D = `sha256:${"0".repeat(64)}`;
  writeFileSync(
    path.join(repo, ".spc", "runs", "run-fixture-1", "metadata.json"),
    JSON.stringify({ runId: "run-fixture-1", kind: "apply", specId: "skc", planId: "plan-fixture-1", baseRevision: rev, createdAt: new Date().toISOString() }),
    "utf8",
  );
  writeFileSync(
    path.join(repo, ".spc", "plans", "plan-fixture-1.json"),
    JSON.stringify({
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-fixture-1", createdAt: new Date().toISOString() },
      spec: { id: "skc", digest: D },
      repository: { revision: rev, snapshotDigest: D },
      tasks: [{ id: "T001", title: "fixture task", kind: "modify", intent: "fixture", targets: { write: ["src/a.ts"] } }],
    }),
    "utf8",
  );
  writeFileSync(
    path.join(repo, ".spc", "harness", "pending", `executor-${name}@1-1.json`),
    JSON.stringify({ id: `executor-${name}@1-1`, role: "executor", key: "T001@1", runId: "run-fixture-1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: '{"fixture":true}', createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
    "utf8",
  );
  // The author-side commit AFTER the dispatch baseline:
  // protected-only (oracle amendment) or source (task territory).
  if (amendProtected) {
    writeFileSync(path.join(repo, "tests", "a.test.ts"), "test amended\n", "utf8");
  } else {
    writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n", "utf8");
  }
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", amendProtected ? "oracle fix" : "task territory"]);
  return repo;
}

const answerFile = (repo: string) => {
  const f = path.join(repo, "answer.json");
  writeFileSync(f, JSON.stringify({ status: "completed", summary: "s", changes: [], commands: [], observations: [], evidenceCandidates: [], followups: [] }), "utf8");
  return f;
};

describe("SC-002: both CLI doors thread protectedPatterns", () => {
  it("a protected-only commit after the baseline does not refuse the submit at the guard door", { timeout: 60_000 }, () => {
    const repo = fixture("oraclefix", true);
    const r = sh(repo, ["agent", "submit", "executor-oraclefix@1-1", "--file", answerFile(repo), "--no-preflight"]);
    // The guard door passes: the refusal class UNMEDIATED_CHANGES does
    // not appear (the submit proceeds to answer, or refuses later for
    // unrelated fixture reasons - never for committed bypass).
    expect(r.stdout).not.toMatch(/UNMEDIATED_CHANGES/);
    expect(r.stdout).toMatch(/Answered executor-oraclefix@1-1/);
  });

  it("control: a source commit after the baseline still refuses at the door, naming the path", { timeout: 60_000 }, () => {
    const repo = fixture("srccommit", false);
    const r = sh(repo, ["agent", "submit", "executor-srccommit@1-1", "--file", answerFile(repo), "--no-preflight"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/UNMEDIATED_CHANGES/);
    expect(r.stdout).toMatch(/src\/a\.ts/);
    // feedback on the request (specs/submit-refusal-feedback)
    const pending = JSON.parse(readFileSync(path.join(repo, ".spc", "harness", "pending", "executor-srccommit@1-1.json"), "utf8")) as { lastError?: string };
    expect(pending.lastError ?? "").toMatch(/UNMEDIATED_CHANGES/);
  });
});
