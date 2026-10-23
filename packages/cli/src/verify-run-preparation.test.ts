import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/verification-preparation.yaml (VP-003): spc verify
// --run prepares its temporary worktree and records the outcome as
// structured preparation evidence in the verification run.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-vrp-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function gitsh(args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: vrp-fixture
  title: fixture
goal: fixture
requirements:
  - id: VRP-001
    statement: Gate passes.
    priority: must
    acceptance:
      - id: VRP-001-A
        type: command
        command: node gate.cjs
        discriminating: true
`;

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc", "runs"), { recursive: true });
mkdirSync(path.join(root, "node_modules", "depmarker"), { recursive: true });
writeFileSync(path.join(root, "specs", "vrp-fixture.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, "node_modules", "depmarker", "index.cjs"), "module.exports = 1;\n", "utf8");
writeFileSync(path.join(root, "node_modules", "depmarker", "package.json"), '{"name":"depmarker","main":"index.cjs"}', "utf8");
// The gate needs node_modules: in the verification worktree it resolves
// only through preparation (linked node_modules).
writeFileSync(path.join(root, "gate.cjs"), "require('depmarker'); process.exit(0);\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\nnode_modules/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "test@example.com"]);
gitsh(["config", "user.name", "test"]);
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);
const head = gitsh(["rev-parse", "HEAD"]);

const runId = "run-vrp-1";
const runDir = path.join(root, ".spc", "runs", runId);
mkdirSync(runDir, { recursive: true });
writeFileSync(
  path.join(runDir, "metadata.json"),
  JSON.stringify({ runId, specId: "vrp-fixture", createdAt: "2026-10-23T00:00:00.000Z", planId: null }),
  "utf8",
);
writeFileSync(
  path.join(runDir, "state.json"),
  JSON.stringify({ status: "succeeded", resultRevision: head, tasks: {}, requirements: {} }),
  "utf8",
);

function latestVerifyRun(): string | null {
  const runs = readdirSync(path.join(root, ".spc", "runs")).filter((d) => d.startsWith("v-"));
  if (runs.length === 0) return null;
  return runs.sort().reverse()[0]!;
}

describe("spc verify --run preparation (VP-003)", () => {
  it("prepares the worktree and records preparation evidence", () => {
    const r = sh(["verify", "--run", runId]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/prepar/i);
    const vrun = latestVerifyRun();
    expect(vrun).not.toBeNull();
    const evidence = readFileSync(path.join(root, ".spc", "runs", vrun!, "evidence.jsonl"), "utf8");
    expect(evidence).toContain("\"kind\":\"preparation\"");
    const record = evidence
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.kind === "preparation") as { outcome: string; payload: { mode?: string } };
    expect(record.outcome).toBe("supports");
    expect(record.payload.mode).toBe("linked");
  });
});
