import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateSubmission } from "@spc/executor";
import { fileDigest, stageChanges } from "@spc/executor";

// Oracle for specs/version-skew-guard.yaml: a guard that misnames its
// cause is a lying instrument. The run that records FILE_CHANGED work
// but has NO attribution store is a signature no current-binary run can
// produce - that refusal is GUARD_VERSION_SKEW with the restart remedy,
// not an UNMEDIATED_CHANGES accusation (receipt: run-mvx79enc, answered
// with post-attribution doors, cancelled on the misnamed refusal). And
// the dry-run that stages its throwaway at base cannot represent
// in-flight repairs - the divergence is named, not reported as
// PATCH_BASE_MISMATCH (receipt: run-mvy5s57s attempt 2).
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-vsg-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});
function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function gitsh(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, "lib"), { recursive: true });
mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc", "runs", "run-skew"), { recursive: true });
mkdirSync(path.join(root, ".spc", "plans"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
writeFileSync(
  path.join(root, "specs", "vsg.yaml"),
  'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: vsg\n  title: VSG\ngoal: fixture\nrequirements:\n  - id: VSG-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: VSG-001-A\n        type: file\n        path: lib/a.ts\n        assert:\n          exists: true\n',
  "utf8",
);
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "t@t"]);
gitsh(["config", "user.name", "t"]);
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);
const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const D = `sha256:${"0".repeat(64)}`;

// The version-skew signature: the run RECORDED prior-attempt work
// (FILE_CHANGED in events.jsonl) but has NO attribution.json.
writeFileSync(
  path.join(root, ".spc", "runs", "run-skew", "metadata.json"),
  JSON.stringify({ runId: "run-skew", kind: "apply", specId: "vsg", planId: "plan-vsg", baseRevision: rev, createdAt: new Date().toISOString() }),
  "utf8",
);
writeFileSync(
  path.join(root, ".spc", "plans", "plan-vsg.json"),
  JSON.stringify({
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-vsg", createdAt: new Date().toISOString() },
    spec: { id: "vsg", digest: D },
    repository: { revision: rev, snapshotDigest: D },
    tasks: [{ id: "T001", title: "t", kind: "modify", intent: "i", targets: { write: ["lib/a.ts"] } }],
  }),
  "utf8",
);
writeFileSync(
  path.join(root, ".spc", "runs", "run-skew", "events.jsonl"),
  JSON.stringify({ seq: 1, type: "FILE_CHANGED", runId: "run-skew", payload: { taskId: "T001", path: "lib/a.ts", change: "modified" } }) + "\n",
  "utf8",
);
const now = Date.now();
function plantRequest(id: string): void {
  writeFileSync(
    path.join(root, ".spc", "harness", "pending", `${id}.json`),
    JSON.stringify({ id, role: "executor", key: `${id.split("-")[1]}`, runId: "run-skew", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: '{"fixture":true}', createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString() }),
    "utf8",
  );
}
const answerFile = (): string => {
  const f = `answer-${Math.random().toString(36).slice(2, 8)}.json`;
  writeFileSync(path.join(root, f), JSON.stringify({ status: "completed", summary: "s", changes: [], commands: [], observations: [], evidenceCandidates: [], followups: [] }), "utf8");
  return f;
};

describe("version-skew submission naming (VSG-001)", () => {
  it("the predicate names the skew signature with the restart remedy, not UNMEDIATED_CHANGES", () => {
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 2;\n", "utf8");
    const r = evaluateSubmission({
      worktreeRoot: root,
      baselineRevision: rev,
      writeTargets: ["lib/a.ts"],
      proposedPaths: [],
      attribution: { writes: [] },
      attributionStoreExists: false,
      priorRecordedWork: true,
    });
    expect(r.decision).toBe("refuse");
    expect(r.code).toBe("GUARD_VERSION_SKEW");
    expect(r.message ?? "").toMatch(/restart the run on the current binary/);
    // With the store present and no coverage, the ordinary accusation holds.
    const honest = evaluateSubmission({
      worktreeRoot: root,
      baselineRevision: rev,
      writeTargets: ["lib/a.ts"],
      proposedPaths: [],
      attribution: { writes: [] },
      attributionStoreExists: true,
      priorRecordedWork: true,
    });
    expect(honest.code).toBe("UNMEDIATED_CHANGES");
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
  });

  it("the CLI door prints the same code and remedy for the same signature", { timeout: 60_000 }, () => {
    plantRequest("executor-T001@2-9");
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 2;\n", "utf8");
    const r = sh(["agent", "submit", "executor-T001@2-9", "--file", answerFile()]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/GUARD_VERSION_SKEW/);
    expect(r.stdout).toMatch(/restart the run on the current binary/);
    expect(sh(["agent", "list"]).stdout).toMatch(/executor-T001@2-9/);
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
  });
});

describe("dry-run worldview divergence (VSG-002)", () => {
  it("a draft that stages clean against the live tree but not the throwaway is named as divergence, not PATCH_BASE_MISMATCH", { timeout: 60_000 }, () => {
    // Compose a valid op against the LIVE tree: an anchor that exists
    // only in the in-flight content (simulating base + prior applied
    // work), i.e. lib/a.ts's current content differs from the base by
    // uncommitted in-flight work.
    const live = "export const a = 1;\n// in-flight marker\n";
    writeFileSync(path.join(root, "lib", "a.ts"), live, "utf8");
    const op = {
      op: "patch",
      path: "lib/a.ts",
      baseDigest: fileDigest(live),
      anchor: "// in-flight marker",
      replacement: "// in-flight marker (repaired)",
    };
    // Sanity: stages clean against the live tree.
    const staged = stageChanges(root, [op]);
    expect(staged.ok).toBe(true);
    const f = `draft-${Math.random().toString(36).slice(2, 8)}.json`;
    writeFileSync(path.join(root, f), JSON.stringify({ status: "completed", summary: "repair", changes: [op], commands: [], observations: [], evidenceCandidates: [], followups: [] }), "utf8");
    plantRequest("executor-T001@3-7");
    const r = sh(["agent", "dry-run", "executor-T001@3-7", "--file", f]);
    expect(r.stdout).toMatch(/in-flight tree/);
    expect(r.stdout).not.toMatch(/PATCH_BASE_MISMATCH/);
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
  });
});
