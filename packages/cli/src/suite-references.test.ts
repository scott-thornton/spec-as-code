import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/suite-references.yaml: a suite is a named command
// definition living in the repository; a criterion references it by
// name; resolution happens BEFORE the memo and cache see anything, so
// two specs referencing one suite are "same command" to the existing
// execution-identity machinery - one physical execution (measured by
// side effect, never inferred from events), one COMMAND_EXECUTED plus
// one COMMAND_RESULT_REUSED, suite id + digest as provenance distinct
// from the shared executionId. An unknown ref is a compile error
// before anything executes.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const repoA = mkdtempSync(path.join(tmpdir(), "spc-suite-refs-"));
const repoB = mkdtempSync(path.join(tmpdir(), "spc-suite-unknown-"));
afterAll(() => {
  rmSync(repoA, { recursive: true, force: true });
  rmSync(repoB, { recursive: true, force: true });
});

function sh(cwd: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
function initRepo(cwd: string): void {
  writeFileSync(path.join(cwd, ".gitignore"), ".spc/\ncounter.txt\n", "utf8");
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.email", "t@t"]);
  git(cwd, ["config", "user.name", "t"]);
}
function specWith(id: string, prop: string, body: string): string {
  return `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: ${id}
  title: ${id}
goal: fixture
requirements:
  - id: ${prop}-001
    statement: holds
    priority: must
    acceptance:
      - id: ${prop}-001-A
${body}
`;
}

// Fixture A: one suite, two referencing specs. counter.mjs appends one
// line per PHYSICAL execution - ground truth, no shell quoting.
writeFileSync(path.join(repoA, "counter.mjs"), "import { appendFileSync } from 'node:fs';\nappendFileSync('counter.txt', 'x\\n');\n", "utf8");
mkdirSync(path.join(repoA, "suites"), { recursive: true });
writeFileSync(
  path.join(repoA, "suites", "battery.yaml"),
  "apiVersion: spc.dev/v1alpha1\nkind: Suite\nmetadata:\n  id: battery\n  title: Counter battery\ncommand: node counter.mjs\n",
  "utf8",
);
mkdirSync(path.join(repoA, "specs"), { recursive: true });
writeFileSync(path.join(repoA, "specs", "sr-a.yaml"), specWith("sr-a", "SRA", "        type: suite\n        ref: battery"), "utf8");
writeFileSync(path.join(repoA, "specs", "sr-b.yaml"), specWith("sr-b", "SRB", "        type: suite\n        ref: battery"), "utf8");
initRepo(repoA);
git(repoA, ["add", "."]);
git(repoA, ["commit", "-q", "-m", "base"]);

// Fixture B: a valid suite plus a spec referencing one that does not exist.
writeFileSync(path.join(repoB, "counter.mjs"), "import { appendFileSync } from 'node:fs';\nappendFileSync('counter.txt', 'x\\n');\n", "utf8");
mkdirSync(path.join(repoB, "suites"), { recursive: true });
writeFileSync(
  path.join(repoB, "suites", "battery.yaml"),
  "apiVersion: spc.dev/v1alpha1\nkind: Suite\nmetadata:\n  id: battery\n  title: Counter battery\ncommand: node counter.mjs\n",
  "utf8",
);
mkdirSync(path.join(repoB, "specs"), { recursive: true });
writeFileSync(path.join(repoB, "specs", "bad.yaml"), specWith("bad", "BAD", "        type: suite\n        ref: nope"), "utf8");
initRepo(repoB);
git(repoB, ["add", "."]);
git(repoB, ["commit", "-q", "-m", "base"]);

function executions(cwd: string): number {
  try {
    return readFileSync(path.join(cwd, "counter.txt"), "utf8").split("\n").filter((l) => l === "x").length;
  } catch {
    return 0;
  }
}

interface EvidencePayload {
  criterionId?: string;
  payload?: {
    command?: string;
    executionId?: string;
    suite?: string;
    suiteDigest?: string;
    reusedFrom?: string;
  };
}

describe("suite-references: shared execution (SR-002)", () => {
  it("two specs referencing one suite execute it exactly once physically, with reuse event, shared executionId and suite provenance", { timeout: 180_000 }, () => {
    const r = sh(repoA, ["verify", "--all"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/sr-a/);
    expect(r.stdout).toMatch(/sr-b/);

    // Ground truth measured by the command's own side effect.
    expect(executions(repoA)).toBe(1);

    // One real execution, one reuse, across both run directories.
    let executed = 0;
    let reused = 0;
    const byCriterion = new Map<string, EvidencePayload["payload"]>();
    for (const run of readdirSync(path.join(repoA, ".spc", "runs"))) {
      const events = readFileSync(path.join(repoA, ".spc", "runs", run, "events.jsonl"), "utf8");
      for (const line of events.split("\n")) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as { type: string };
        if (e.type === "COMMAND_EXECUTED") executed += 1;
        if (e.type === "COMMAND_RESULT_REUSED") reused += 1;
      }
      try {
        for (const line of readFileSync(path.join(repoA, ".spc", "runs", run, "evidence.jsonl"), "utf8").split("\n")) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as EvidencePayload;
          if (e.criterionId && e.payload) byCriterion.set(e.criterionId, e.payload);
        }
      } catch {
        // no evidence file
      }
    }
    expect(executed).toBe(1);
    expect(reused).toBe(1);

    // Suite provenance on both criteria; execution identity shared.
    const a = byCriterion.get("SRA-001-A");
    const b = byCriterion.get("SRB-001-A");
    expect(a?.command).toBe("node counter.mjs");
    expect(b?.command).toBe("node counter.mjs");
    expect(a?.suite).toBe("battery");
    expect(b?.suite).toBe("battery");
    expect(a?.suiteDigest).toBeTruthy();
    expect(b?.suiteDigest).toBe(a?.suiteDigest);
    expect(a?.executionId).toBeTruthy();
    expect(b?.executionId).toBe(a?.executionId);
  });

  it("standalone single-spec verification executes the suite itself (SR-004)", { timeout: 120_000 }, () => {
    rmSync(path.join(repoA, "counter.txt"), { force: true });
    const r = sh(repoA, ["verify", "--all", "specs/sr-a.yaml"]);
    expect(r.status).toBe(0);
    expect(executions(repoA)).toBe(1);
  });
});

describe("suite-references: unknown ref and registry validation (SR-001, SR-003, SR-005)", () => {
  it("spec validate names the unknown reference; verify fails before any command executes", { timeout: 120_000 }, () => {
    const v = sh(repoB, ["spec", "validate", "specs/bad.yaml"]);
    expect(v.status).toBe(1);
    expect(v.stdout).toMatch(/nope/);

    const w = sh(repoB, ["verify", "--all"]);
    expect(w.status).not.toBe(0);
    expect(w.stdout).toMatch(/nope/);
    // Nothing executed: the unknown ref fails before any criterion runs.
    expect(executions(repoB)).toBe(0);
  });

  it("suite validate is green on a valid registry and names the offending file on malformed or duplicate definitions", { timeout: 60_000 }, () => {
    rmSync(path.join(repoB, "specs", "bad.yaml"), { force: true });
    expect(sh(repoB, ["suite", "validate"]).status).toBe(0);

    writeFileSync(path.join(repoB, "suites", "broken.yaml"), "apiVersion: spc.dev/v1alpha1\nkind: Suite\nmetadata:\n  id: broken\n  title: No command\n", "utf8");
    const broken = sh(repoB, ["suite", "validate"]);
    expect(broken.status).toBe(1);
    expect(broken.stdout).toMatch(/broken\.yaml/);

    rmSync(path.join(repoB, "suites", "broken.yaml"), { force: true });
    writeFileSync(
      path.join(repoB, "suites", "dup.yaml"),
      "apiVersion: spc.dev/v1alpha1\nkind: Suite\nmetadata:\n  id: battery\n  title: Duplicate\ncommand: node counter.mjs\n",
      "utf8",
    );
    const dup = sh(repoB, ["suite", "validate"]);
    expect(dup.status).toBe(1);
    expect(dup.stdout).toMatch(/battery/);
    rmSync(path.join(repoB, "suites", "dup.yaml"), { force: true });
  });

  it("suite list renders ids, commands and reference counts", { timeout: 60_000 }, () => {
    const list = sh(repoB, ["suite", "list"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/battery/);
    expect(list.stdout).toMatch(/node counter\.mjs/);
    expect(list.stdout).toMatch(/0/);

    const listA = sh(repoA, ["suite", "list"]);
    expect(listA.status).toBe(0);
    expect(listA.stdout).toMatch(/battery/);
    // Two criteria across specs/ reference the battery in fixture A.
    expect(listA.stdout).toMatch(/2/);
  });
});
