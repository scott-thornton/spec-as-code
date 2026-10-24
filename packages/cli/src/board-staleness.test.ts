import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Oracle for specs/board-staleness.yaml: cached verification under the
// conservative zero-tracked-changes contract - CACHED only when every
// eligibility condition holds, every failure fails open to execution,
// --all forces the full sweep.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-bs-"));
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
  id: bs-fixture
  title: fixture
goal: fixture
requirements:
  - id: BSF-001
    statement: Gate passes.
    priority: must
    acceptance:
      - id: BSF-001-A
        type: command
        command: node gate.cjs
        discriminating: true
`;

mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, "specs", "bs-fixture.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, "gate.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "test@example.com"]);
gitsh(["config", "user.name", "test"]);
writeFileSync(path.join(root, ".keep"), "", "utf8");
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);

function vrunCount(): number {
  return readdirSync(path.join(root, ".spc", "runs")).filter((d) => d.startsWith("v-")).length;
}

/** Build a prior verify run for the spec from raw, valid parts. */
async function buildPriorRun(overrides: {
  dirty?: boolean;
  requirementStatus?: string;
  specDigest?: string;
  configDigest?: string;
  baseRevision?: string;
}): Promise<void> {
  const runtime = await import("@spc/runtime");
  const { compileSpecFile } = await import("@spc/repo");
  const specId = "bs-fixture";
  const runId = `v-prior-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(root, ".spc", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const compiled = compileSpecFile(path.join(root, "specs", "bs-fixture.yaml"));
  const digest = overrides.specDigest ?? (compiled.ok && compiled.ir ? compiled.ir.digest : "sha256:" + "0".repeat(64));
  const configDigest =
    overrides.configDigest ?? runtime.configDigestOf(path.join(root, ".spc", "config.yaml"));
  const baseRevision = overrides.baseRevision ?? gitsh(["rev-parse", "HEAD"]);
  writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({
      runId,
      kind: "verify",
      specId,
      specDigest: digest,
      configDigest,
      baseRevision,
      createdAt: "2026-10-24T00:00:00.000Z",
    }),
    "utf8",
  );
  const events = new runtime.EventStore(path.join(dir, "events.jsonl"), runId);
  events.append("RUN_CREATED", { runId, kind: "verify", specId, baseRevision, dirty: overrides.dirty ?? false });
  const evidence = new runtime.EvidenceStore(path.join(dir, "evidence.jsonl"));
  evidence.add({
    id: "EV-0001",
    runId,
    propertyRefs: ["BSF-001"],
    criterionId: "BSF-001-A",
    kind: "command",
    outcome: "supports",
    producer: { type: "runtime" },
    timestamp: "2026-10-24T00:00:00.000Z",
    repositoryRevision: baseRevision,
    payload: { command: "node gate.cjs" },
  });
  writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      status: "succeeded",
      tasks: {},
      requirements: { BSF-001: { propertyId: "BSF-001", status: overrides.requirementStatus ?? "satisfied" } },
    }),
    "utf8",
  );
}

beforeEach(() => {
  rmSync(path.join(root, ".spc", "runs"), { recursive: true, force: true });
  mkdirSync(path.join(root, ".spc", "runs"), { recursive: true });
});

describe("board staleness caching (board-staleness)", () => {
  it("CACHED when fully eligible: no new run, exit 0 (BS-001)", async () => {
    await buildPriorRun({});
    const before = vrunCount();
    const r = sh(["verify", "specs/bs-fixture.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/CACHED/);
    expect(vrunCount()).toBe(before);
  });

  it("any tracked change since the prior base re-verifies (BS-002)", async () => {
    await buildPriorRun({});
    writeFileSync(path.join(root, "unrelated.txt"), "a change anywhere invalidates everything\n", "utf8");
    gitsh(["add", "."]);
    gitsh(["commit", "-q", "-m", "tracked change"]);
    const r = sh(["verify", "specs/bs-fixture.yaml"]);
    expect(r.stdout).not.toMatch(/CACHED/);
    expect(vrunCount()).toBe(2); // prior + fresh execution
  });

  it("a dirty current tree re-verifies (BS-002)", async () => {
    await buildPriorRun({});
    writeFileSync(path.join(root, "gate.cjs"), "process.exit(0);\n// dirty\n", "utf8");
    const r = sh(["verify", "specs/bs-fixture.yaml"]);
    expect(r.stdout).not.toMatch(/CACHED/);
    writeFileSync(path.join(root, "gate.cjs"), "process.exit(0);\n", "utf8");
  });

  it("a spec digest mismatch (amendment) re-verifies (BS-002)", async () => {
    await buildPriorRun({ specDigest: "sha256:" + "a".repeat(64) });
    const r = sh(["verify", "specs/bs-fixture.yaml"]);
    expect(r.stdout).not.toMatch(/CACHED/);
  });

  it("a config digest mismatch re-verifies (BS-002)", async () => {
    await buildPriorRun({ configDigest: "sha256:" + "b".repeat(64) });
    const r = sh(["verify", "specs/bs-fixture.yaml"]);
    expect(r.stdout).not.toMatch(/CACHED/);
  });

  it("a prior run that verified a dirty tree is ineligible (BS-002)", async () => {
    await buildPriorRun({ dirty: true });
    const r = sh(["verify", "specs/bs-fixture.yaml"]);
    expect(r.stdout).not.toMatch(/CACHED/);
  });

  it("a prior unsatisfied result is ineligible - the flake-recovery case re-verifies (BS-002)", async () => {
    await buildPriorRun({ requirementStatus: "unsatisfied" });
    const r = sh(["verify", "specs/bs-fixture.yaml"]);
    expect(r.stdout).not.toMatch(/CACHED/);
    expect(vrunCount()).toBe(2);
  });

  it("an unresolvable git comparison fails open to verification (BS-002)", async () => {
    await buildPriorRun({ baseRevision: "0".repeat(40) });
    const r = sh(["verify", "specs/bs-fixture.yaml"]);
    expect(r.stdout).not.toMatch(/CACHED/);
  });

  it("--all forces full verification even when eligible (BS-003)", async () => {
    await buildPriorRun({});
    const r = sh(["verify", "--all", "specs/bs-fixture.yaml"]);
    expect(r.stdout).not.toMatch(/CACHED/);
    expect(vrunCount()).toBe(2);
  });
});
