import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git } from "@spc/repo";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-dryrun-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: dryrun-fixture
  title: Dry-run fixture
goal: fixture
requirements:
  - id: DR-001
    statement: The module exports TWO.
    priority: must
    acceptance:
      - id: DR-001-A
        type: file
        path: src/mod.cjs
        assert:
          contains: "TWO"
  - id: DR-002
    statement: The module is syntactically valid node.
    priority: must
    acceptance:
      - id: DR-002-A
        type: command
        command: node --check src/mod.cjs
`;

function sh(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}

function gitsh(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, "src"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
writeFileSync(path.join(root, "specs", "dryrun-fixture.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, "src", "mod.cjs"), "module.exports = 'ONE';\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "test@example.com"]);
gitsh(["config", "user.name", "test"]);
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);

// A pending executor request whose payload carries the fixture task with
// both criteria visible as relevantProperties.
const promptPayload = {
  spec: { id: "dryrun-fixture", title: "Dry-run fixture", goal: "fixture" },
  task: { id: "T001", title: "write the module", kind: "modify", intent: "make it export TWO" },
  relevantProperties: [
    {
      id: "DR-001",
      statement: "The module exports TWO.",
      priority: "must",
      acceptance: [
        { id: "DR-001-A", type: "file", summary: "file src/mod.cjs" },
      ],
    },
    {
      id: "DR-002",
      statement: "The module is syntactically valid node.",
      priority: "must",
      acceptance: [
        { id: "DR-002-A", type: "command", summary: "$ node --check src/mod.cjs" },
      ],
    },
  ],
};
writeFileSync(
  path.join(root, ".spc", "harness", "pending", "executor-T001@1-1.json"),
  JSON.stringify({
    id: "executor-T001@1-1",
    role: "executor",
    key: "T001@1",
    schemaName: "ExecutorResult",
    jsonSchema: { type: "object" },
    system: "sys",
    prompt: `--- harness instructions ---\nanswer\n\nExecute the following task. Respond with JSON only.\n\n${JSON.stringify(promptPayload, null, 2)}`,
    createdAt: "2026-10-19T00:00:00.000Z",
  }),
  "utf8",
);

function draftAnswer(changes: unknown[]): string {
  const file = path.join(root, "draft.json");
  writeFileSync(
    file,
    JSON.stringify({ status: "completed", summary: "s", changes, observations: [], evidenceCandidates: [], followups: [] }),
    "utf8",
  );
  return file;
}

describe("spc agent dry-run", () => {
  it("stages the answer's changes and reports each criterion's outcome without touching the real tree", () => {
    const draft = draftAnswer([
      { op: "update", path: "src/mod.cjs", content: "module.exports = 'TWO';\n" },
    ]);
    const r = sh(["agent", "dry-run", "executor-T001@1-1", "--file", draft]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DR-001-A");
    expect(r.stdout).toContain("DR-002-A");
    expect(r.stdout).toContain("pass");
    // The real tree is untouched: dry-run never writes outside its staging worktree.
    expect(readFileSync(path.join(root, "src", "mod.cjs"), "utf8")).toBe("module.exports = 'ONE';\n");
  });

  it("reports failing criteria with their failure shape when the draft is wrong", () => {
    const draft = draftAnswer([
      { op: "update", path: "src/mod.cjs", content: "module.exports = still ONE\n" },
    ]);
    const r = sh(["agent", "dry-run", "executor-T001@1-1", "--file", draft]);
    expect(r.status).toBe(0); // advisory: report-only, never gates
    expect(r.stdout).toContain("DR-001-A");
    expect(r.stdout).toMatch(/fail|contradict/i);
    expect(readFileSync(path.join(root, "src", "mod.cjs"), "utf8")).toBe("module.exports = 'ONE';\n");
  });

  it("refuses a draft whose change set itself would not stage", () => {
    const draft = draftAnswer([
      { op: "patch", path: "src/mod.cjs", baseDigest: "sha256:" + "0".repeat(64), anchor: "absent", replacement: "x" },
    ]);
    const r = sh(["agent", "dry-run", "executor-T001@1-1", "--file", draft]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("PATCH_");
  });

  it("flags a command whose suite never collects tests (failureShape surfaces in the report)", () => {
    // Swap the criterion command for one that fails as a collection error.
    const specFile = path.join(root, "specs", "dryrun-fixture.yaml");
    writeFileSync(specFile, SPEC.replace("node --check src/mod.cjs", `node -e "console.log('      Tests  no tests'); process.exit(1)"`), "utf8");
    gitsh(["add", "."]);
    gitsh(["commit", "-q", "-m", "collection-failure criterion"]);
    const draft = draftAnswer([
      { op: "update", path: "src/mod.cjs", content: "module.exports = 'TWO';\n" },
    ]);
    const r = sh(["agent", "dry-run", "executor-T001@1-1", "--file", draft]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("suite-did-not-run");
    // restore
    writeFileSync(specFile, SPEC, "utf8");
    gitsh(["add", "."]);
    gitsh(["commit", "-q", "-m", "restore criterion"]);
  });

  it("errors cleanly for a request id that is not pending", () => {
    const draft = draftAnswer([]);
    const r = sh(["agent", "dry-run", "executor-NOPE@1-1", "--file", draft]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("executor-NOPE@1-1");
  });
});
