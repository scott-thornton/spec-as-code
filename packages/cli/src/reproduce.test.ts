import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileSpecFile } from "@spc/repo";

// Oracle for specs/reproduce-verification.yaml REPRO-001/REPRO-004
// (red, committed pre-run): spc reproduce <runId> re-executes a run's
// recorded verification at its committed result revision through the
// existing verify --run machinery (new run record, original untouched)
// and reports the comparison linking both runs, both evidence IDs,
// both revisions, and the command digests. Today the command does not
// exist - this is red.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-repro-"));
const RUN_ID = "run-repro0001-bbbb";
let resultRevision = "";
let originalDigest = "";

beforeAll(() => {
  const sh = (args: string[]): void => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  const write = (rel: string, content: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content, "utf8");
  };
  write("fact.txt", "the fact\n");
  write("check.js", "process.exit(require('fs').existsSync('fact.txt') ? 0 : 1);\n");
  const specYaml = [
    "apiVersion: spc.dev/v1alpha1",
    "kind: Spec",
    "metadata:",
    "  id: repro-demo",
    "  title: Repro demo",
    "goal: >",
    "  repro oracle fixture",
    "requirements:",
    "  - id: RD-001",
    "    statement: deterministic criteria",
    "    priority: must",
    "    acceptance:",
    "      - id: RD-001-A",
    "        type: file",
    "        path: fact.txt",
    "        assert:",
    "          exists: true",
    "      - id: RD-001-B",
    "        type: command",
    "        command: node check.js",
    "        expect: {exitCode: 0}",
  ].join("\n") + "\n";
  write("specs/repro-demo.yaml", specYaml);
  sh(["init", "-q", "-b", "main"]);
  sh(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  sh(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
  resultRevision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  // The real writer records the COMPILED spec digest, not a text digest.
  const compiled = compileSpecFile(path.join(root, "specs", "repro-demo.yaml"));
  originalDigest = compiled.ok && compiled.ir ? compiled.ir.digest : "sha256:unrecorded";
  // A fabricated but faithful original run: metadata, state (result
  // revision), and evidence naming both criteria as supports.
  const runDir = path.join(root, ".spc", "runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "metadata.json"), JSON.stringify({ kind: "apply", runId: RUN_ID, specId: "repro-demo", specDigest: originalDigest, createdAt: "2026-11-10T00:00:00.000Z", baseRevision: resultRevision }, null, 2) + "\n", "utf8");
  writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ status: "succeeded", resultRevision }, null, 2) + "\n", "utf8");
  const ev = (id: string, criterionId: string, kind: string, payload: Record<string, unknown>) =>
    JSON.stringify({ id, runId: RUN_ID, criterionId, propertyRefs: ["RD-001"], kind, outcome: "supports", producer: { type: "runtime" }, timestamp: "2026-11-10T00:00:01.000Z", repositoryRevision: resultRevision, payload });
  writeFileSync(path.join(runDir, "evidence.jsonl"), [ev("ev-orig-1", "RD-001-A", "file", { path: "fact.txt", observed: { exists: true } }), ev("ev-orig-2", "RD-001-B", "command", { command: "node check.js", exitCode: 0 })].join("\n") + "\n", "utf8");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function digestTree(dir: string): string {
  const hash = createHash("sha256");
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name);
      hash.update(entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

describe("REPRO-001/REPRO-004: reproduce end to end", () => {
  it("a deterministic run reproduces: both criteria reproduced, both runs and both evidence ids linked, original untouched", () => {
    const originalBefore = digestTree(path.join(root, ".spc", "runs", RUN_ID));
    const runsBefore = new Set(readdirSync(path.join(root, ".spc", "runs")));
    const r = spawnSync(process.execPath, [CLI, "reproduce", RUN_ID], { cwd: root, encoding: "utf8", timeout: 120_000 });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    expect(r.status).toBe(0);
    expect(out).toMatch(/reproduc/i);
    expect(out).toContain("RD-001-A");
    expect(out).toContain("RD-001-B");
    // Both evidence identities preserved.
    expect(out).toContain("ev-orig-1");
    expect(out).toContain("ev-orig-2");
    // Both run records linked (the original id and the new one).
    expect(out).toContain(RUN_ID);
    expect(out).toMatch(/verification run|new run/i);
    // The original run directory is byte-identical.
    expect(digestTree(path.join(root, ".spc", "runs", RUN_ID))).toBe(originalBefore);
    // A NEW run record exists.
    const runsAfter = readdirSync(path.join(root, ".spc", "runs"));
    expect(runsAfter.filter((d) => !runsBefore.has(d)).length).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it("an unknown run refuses by name (exit 2), never an empty report", () => {
    const r = spawnSync(process.execPath, [CLI, "reproduce", "run-nosuch-0000"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect((r.stdout ?? "") + (r.stderr ?? "")).toMatch(/run-nosuch-0000|not found/i);
  });
});
