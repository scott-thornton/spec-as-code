import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/preflight-gates.yaml (PG-001..PG-005): dry-run links
// real dependencies into its worktree, runs repo gates on request,
// predicts apply-time enforcement refusals, stages against the request's
// base revision instead of live-tree drift, and records each preflight.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-preflight-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BASE_CONTENT = "module.exports = 'ONE';\n";
const DRIFTED_CONTENT = `${BASE_CONTENT}// drifted\n`;
const digest = (s: string) => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: preflight-fixture
  title: Preflight fixture
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

function gitsh(args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, "src"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
mkdirSync(path.join(root, "node_modules", "depmarker"), { recursive: true });
writeFileSync(
  path.join(root, "package.json"),
  JSON.stringify(
    { name: "preflight-fixture", version: "1.0.0", private: true, scripts: { test: "node gates-test.cjs", lint: "node gates-lint.cjs" } },
    null,
    2,
  ),
  "utf8",
);
writeFileSync(
  path.join(root, "node_modules", "depmarker", "package.json"),
  JSON.stringify({ name: "depmarker", version: "1.0.0", main: "index.cjs" }),
  "utf8",
);
writeFileSync(path.join(root, "node_modules", "depmarker", "index.cjs"), "module.exports = 42;\n", "utf8");
// Both gates require depmarker, which only resolves through the linked
// node_modules; the test gate additionally requires the draft's change.
writeFileSync(
  path.join(root, "gates-test.cjs"),
  `require("depmarker");\nconst v = require("./src/mod.cjs");\nif (!String(v).includes("TWO")) { console.error("mod does not export TWO"); process.exit(1); }\n`,
  "utf8",
);
writeFileSync(path.join(root, "gates-lint.cjs"), `require("depmarker");\n`, "utf8");
writeFileSync(path.join(root, "specs", "preflight-fixture.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, "src", "mod.cjs"), BASE_CONTENT, "utf8");
writeFileSync(
  path.join(root, ".spc", "config.yaml"),
  ["version: 1", "provider:", "  name: harness", "verification:", "  protectedPaths:", '    - "specs/**"'].join("\n") + "\n",
  "utf8",
);
writeFileSync(path.join(root, ".gitignore"), ".spc/\nnode_modules/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "test@example.com"]);
gitsh(["config", "user.name", "test"]);
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);
const baseSha = gitsh(["rev-parse", "HEAD"]);

// Live-tree drift AFTER the base commit: the request's base and the live
// tree now disagree on src/mod.cjs. Staging must bind to the former.
writeFileSync(path.join(root, "src", "mod.cjs"), DRIFTED_CONTENT, "utf8");

const promptPayload = {
  spec: { id: "preflight-fixture", title: "Preflight fixture", goal: "fixture" },
  repository: { revision: baseSha, languages: ["javascript"], commands: {} },
  task: { id: "T001", title: "write the module", kind: "modify", intent: "make it export TWO", targets: { write: ["src/**"] } },
  relevantProperties: [
    {
      id: "DR-001",
      statement: "The module exports TWO.",
      priority: "must",
      acceptance: [{ id: "DR-001-A", type: "file", summary: "file src/mod.cjs" }],
    },
    {
      id: "DR-002",
      statement: "The module is syntactically valid node.",
      priority: "must",
      acceptance: [{ id: "DR-002-A", type: "command", summary: "$ node --check src/mod.cjs" }],
    },
  ],
  allowedWritePaths: ["src/**"],
};
const REQUEST_ID = "executor-T001@1-1";
writeFileSync(
  path.join(root, ".spc", "harness", "pending", `${REQUEST_ID}.json`),
  JSON.stringify({
    id: REQUEST_ID,
    role: "executor",
    key: "T001@1",
    schemaName: "ExecutorResult",
    jsonSchema: { type: "object", required: ["status", "summary", "changes"] },
    system: "sys",
    prompt: `--- harness instructions ---\nanswer\n\nExecute the following task. Respond with JSON only.\n\n${JSON.stringify(promptPayload, null, 2)}`,
    createdAt: new Date().toISOString(),
  }),
  "utf8",
);

function draftPath(name: string, answer: unknown): string {
  const file = path.join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify(answer), "utf8");
  return file;
}

const complete = (changes: unknown[]) => ({
  status: "completed",
  summary: "s",
  changes,
  observations: [],
  evidenceCandidates: [],
  followups: [],
});

const basePatch = {
  op: "patch",
  path: "src/mod.cjs",
  baseDigest: digest(BASE_CONTENT),
  anchor: "module.exports = 'ONE';",
  replacement: "module.exports = 'TWO';",
};

describe("spc agent dry-run preflight (preflight-gates)", () => {
  it("stages at the request base, links dependencies, and runs criteria plus repo gates (PG-001/2/4)", { timeout: 120_000 }, () => {
    const draft = draftPath("good", complete([basePatch]));
    const r = sh(["agent", "dry-run", REQUEST_ID, "--file", draft, "--gates"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DR-001-A");
    expect(r.stdout).toContain("DR-002-A");
    // The report names the base it staged against: the request's revision.
    expect(r.stdout).toContain(baseSha.slice(0, 10));
    // Both declared gates ran and passed inside the worktree: depmarker
    // resolves only through the linked node_modules, and the test gate
    // needs the draft's TWO to be present.
    expect(r.stdout).toMatch(/gate/i);
    expect(r.stdout).toMatch(/test\b[\s\S]{0,40}exit 0/);
    expect(r.stdout).toMatch(/lint\b[\s\S]{0,40}exit 0/);
    // The live tree (including its drift) is untouched.
    expect(readFileSync(path.join(root, "src", "mod.cjs"), "utf8")).toBe(DRIFTED_CONTENT);
  });

  it("predicts out-of-scope writes instead of letting apply refuse them (PG-003)", () => {
    const draft = draftPath("oos", complete([{ op: "create", path: "docs/notes.md", content: "x" }]));
    const r = sh(["agent", "dry-run", REQUEST_ID, "--file", draft]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("OUT_OF_SCOPE_WRITE");
  });

  it("predicts protected-path writes (PG-003)", () => {
    const draft = draftPath(
      "prot",
      complete([
        {
          op: "patch",
          path: "specs/preflight-fixture.yaml",
          baseDigest: digest(SPEC),
          anchor: "goal: fixture",
          replacement: "goal: fixture2",
        },
      ]),
    );
    const r = sh(["agent", "dry-run", REQUEST_ID, "--file", draft]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("PROTECTED_PATH_WRITE");
  });

  it("reports a schema-invalid draft instead of staging it (PG-003)", () => {
    const draft = draftPath("schemabad", { status: "completed" });
    const r = sh(["agent", "dry-run", REQUEST_ID, "--file", draft]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/schema/i);
  });

  it("refuses a draft built from drifted live-tree content (PG-004)", () => {
    const drifted = { ...basePatch, baseDigest: digest(DRIFTED_CONTENT) };
    const draft = draftPath("drift", complete([drifted]));
    const r = sh(["agent", "dry-run", REQUEST_ID, "--file", draft]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("PATCH_BASE_MISMATCH");
  });

  it("records each preflight and surfaces counts in agent list (PG-005)", () => {
    const record = path.join(root, ".spc", "harness", "preflights.jsonl");
    const lines = readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id: string });
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(l.id).toBe(REQUEST_ID);
    const list = sh(["agent", "list"]);
    expect(list.stdout).toContain("preflighted");
  });
});
