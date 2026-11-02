import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertNever, compileSpecSource } from "@spc/core";
import { verifyCriterion } from "@spc/verifier";

// Oracle for specs/tooling-sweep.yaml. TSW-001: the compiler enforces
// union exhaustiveness (assertNever default arms) and every criterion
// type still dispatches - the receipts were the summarizeCriterion and
// lintSpec breaks when the suite member joined the union. TSW-002:
// verify --all prints its execution accounting (hand-counted from
// events four times this session). TSW-003: spc suite list names the
// exact-match conversion candidates (the sweep's checklist).
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-tsw-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});
function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

describe("exhaustive unions (TSW-001)", () => {
  it("assertNever throws on a reached default, and every criterion type dispatches through verifyCriterion unchanged", async () => {
    expect(() => assertNever("reached" as never)).toThrow();
    const ir = compileSpecSource(
      'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: tswd\n  title: d\ngoal: g\nrequirements:\n  - id: D-001\n    statement: s\n    priority: must\n    acceptance:\n      - id: D-001-A\n        type: file\n        path: none.txt\n        assert:\n          exists: false\n',
      "specs/d.yaml",
    );
    expect(ir.ok).toBe(true);
    // A file criterion dispatches without touching any default arm.
    const r = await verifyCriterion(
      { id: "D-001-A", type: "file", path: "none.txt", assert: { exists: false } },
      ir.ir!.properties[0]!,
      { runId: "r", cwd: root, repositoryRevision: "0", config: {} as never, provider: null },
    );
    expect(r.evidence.outcome).toBe("supports");
    // The suite member dispatches to its normalization-must-run-first
    // refusal rather than falling through a default.
    await expect(
      verifyCriterion(
        { id: "D-001-B", type: "suite", ref: "nope" } as never,
        ir.ir!.properties[0]!,
        { runId: "r", cwd: root, repositoryRevision: "0", config: {} as never, provider: null },
      ),
    ).rejects.toThrow(/unresolved suite reference/);
  });
});

// Shared-command fixture for the reuse line: two specs, one command.
const specA = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: tswa
  title: A
goal: g
requirements:
  - id: A-001
    statement: s
    priority: must
    acceptance:
      - id: A-001-A
        type: command
        command: node gate.cjs
`;
const specB = specA.replace("tswa", "tswb").replace(/A-001/g, "B-001");
mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, "suites"), { recursive: true });
mkdirSync(path.join(root, ".spc"), { recursive: true });
writeFileSync(path.join(root, "specs", "a.yaml"), specA, "utf8");
writeFileSync(path.join(root, "specs", "b.yaml"), specB, "utf8");
writeFileSync(path.join(root, "gate.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(
  path.join(root, "suites", "gate.yaml"),
  'apiVersion: spc.dev/v1alpha1\nkind: Suite\nmetadata:\n  id: gate-battery\n  title: Gate\ncommand: node gate.cjs\n',
  "utf8");
writeFileSync(path.join(root, "specs", "c.yaml"), specA.replace("tswa", "tswc").replace(/A-001/g, "C-001").replace("node gate.cjs", "node other.cjs"), "utf8");
writeFileSync(path.join(root, "other.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

describe("reuse accounting (TSW-002)", () => {
  it("verify --all prints the invocation's execution accounting", { timeout: 180_000 }, () => {
    const r = sh(["verify", "--all"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Executions: \d+ executed, \d+ reused \(\d+% reuse\), \d+ spec\(s\) freshness-cached, wall \d+s/);
    // The shared command ran once physically and was reused once.
    expect(r.stdout).toMatch(/1 reused/);
  });
});

describe("duplicate suites surfaced (TSW-003)", () => {
  it("spc suite list names exact-match criteria per suite; near-misses never listed", { timeout: 60_000 }, () => {
    const r = sh(["suite", "list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/gate-battery: 2 exact-match criteria/);
    expect(r.stdout).toMatch(/tswa\/A-001-A/);
    expect(r.stdout).toMatch(/tswb\/B-001-A/);
    expect(r.stdout).not.toContain("tswc/C-001-A");
    expect(r.stdout).not.toContain("node other.cjs");
  });
});
