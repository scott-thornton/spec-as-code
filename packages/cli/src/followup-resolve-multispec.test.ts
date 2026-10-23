import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/followup-resolve-multispec.yaml: follow-up resolution
// in a multi-spec repository (the slerp CHK3639 field report - resolve
// was unusable because the CLI assumed the repo holds exactly one spec).
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-fr-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}

function gitsh(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const specA = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: fr-spec-a
  title: A
goal: fixture a
requirements:
  - id: FRP-001
    statement: Gate passes.
    priority: must
    acceptance:
      - id: FRP-001-A
        type: command
        command: node gate.cjs
        discriminating: true
`;
const specB = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: fr-spec-b
  title: B
goal: fixture b
requirements:
  - id: FRQ-001
    statement: Other gate passes.
    priority: must
    acceptance:
      - id: FRQ-001-A
        type: command
        command: node gate.cjs
        discriminating: true
`;

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc", "runs"), { recursive: true });
writeFileSync(path.join(root, "specs", "fr-a.yaml"), specA, "utf8");
writeFileSync(path.join(root, "specs", "fr-b.yaml"), specB, "utf8");
writeFileSync(path.join(root, "gate.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\nnode_modules/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "test@example.com"]);
gitsh(["config", "user.name", "test"]);
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);

function makeRun(runId: string, specId: string): void {
  const dir = path.join(root, ".spc", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({ runId, specId, createdAt: "2026-10-23T00:00:00.000Z" }),
    "utf8",
  );
  writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({ status: "succeeded", requirements: {} }),
    "utf8",
  );
  writeFileSync(
    path.join(dir, "followups.json"),
    JSON.stringify([
      {
        id: "F-001",
        runId,
        type: "manual_verification",
        blocking: true,
        title: "Confirm the build gate",
        description: "Operator confirmation of the build gate",
        propertyId: "FRP-001",
        criterionId: "FRP-001-A",
        options: [
          { id: "confirm", description: "confirmed" },
          { id: "reject", description: "rejected" },
        ],
        status: "open",
        createdAt: "2026-10-23T00:00:00.000Z",
      },
    ]),
    "utf8",
  );
}

makeRun("run-fr1", "fr-spec-a");

describe("spc followup resolve in multi-spec repositories", () => {
  it("resolves with --run by deriving the spec from the run's specId (FR-001)", () => {
    const r = sh([
      "followup",
      "resolve",
      "F-001",
      "--run",
      "run-fr1",
      "--option",
      "confirm",
      "--note",
      "operator confirmed the gate",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Resolved F-001");
  });

  it("resolves without --run when the follow-up id is unique across runs (FR-001)", () => {
    makeRun("run-fr2", "fr-spec-b");
    // A second run with the SAME follow-up id still open: ambiguity is
    // real (test 1 resolved run-fr1's F-001, so it no longer counts).
    const ambDir = path.join(root, ".spc", "runs", "run-fr-amb");
    mkdirSync(ambDir, { recursive: true });
    writeFileSync(
      path.join(ambDir, "metadata.json"),
      JSON.stringify({ runId: "run-fr-amb", specId: "fr-spec-a", createdAt: "2026-10-23T00:00:00.000Z" }),
      "utf8",
    );
    writeFileSync(
      path.join(ambDir, "state.json"),
      JSON.stringify({ status: "succeeded", requirements: {} }),
      "utf8",
    );
    writeFileSync(path.join(ambDir, "followups.json"), "[]", "utf8");
    makeRun("run-fr2", "fr-spec-b");
    // run-fr2 carries both F-001 (ambiguous with run-fr-amb) and F-009.
    writeFileSync(
      path.join(root, ".spc", "runs", "run-fr-amb", "followups.json"),
      JSON.stringify([
        {
          id: "F-001",
          runId: "run-fr-amb",
          type: "manual_verification",
          blocking: true,
          title: "Duplicate id",
          description: "same follow-up id in another run",
          options: [{ id: "confirm", description: "confirmed" }],
          status: "open",
          createdAt: "2026-10-23T00:00:00.000Z",
        },
      ]),
      "utf8",
    );
    const ambiguous = sh(["followup", "resolve", "F-001", "--option", "confirm"]);
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain("--run");

    // A unique id in run-fr2 resolves via its own spec derivation.
    const dir = path.join(root, ".spc", "runs", "run-fr2");
    writeFileSync(
      path.join(dir, "followups.json"),
      JSON.stringify([
        {
          id: "F-009",
          runId: "run-fr2",
          type: "investigation",
          blocking: false,
          title: "Note only",
          description: "no criterion",
          options: [{ id: "confirm", description: "confirmed" }],
          status: "open",
          createdAt: "2026-10-23T00:00:00.000Z",
        },
      ]),
      "utf8",
    );
    const r = sh(["followup", "resolve", "F-009", "--option", "confirm", "--note", "n"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Resolved F-009");
  });

  it("names the missing spec id when the run's spec is gone (FR-002)", () => {
    makeRun("run-fr3", "fr-spec-missing");
    const r = sh(["followup", "resolve", "F-001", "--run", "run-fr3", "--option", "confirm"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("fr-spec-missing");
  });
});
